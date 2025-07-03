const express = require('express');
const bodyParser = require('body-parser');
const schedule = require('node-schedule');
const axios = require('axios');
const qs = require('qs');
const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// SSL Certificate
const key = fs.readFileSync(path.join(__dirname, 'certs', 'key.pem'));
const cert = fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem'));

let tasks = [];
const logs = [];
let cookies = {}; // Store cookies by task key

// Utility function to log to both console and in-memory log
function log(message) {
	const timestamp = new Date().toISOString();
	const logEntry = `[${timestamp}] ${message}`;
	logs.push(logEntry);
	console.log(logEntry);
}

// Login function with cookie reuse
async function login(email, password, dir, taskKey) {
	// For scheduled tasks, always get a fresh login to avoid cookie expiration issues
	const isScheduledTask = taskKey.includes('_scheduled');

	// Reuse valid cookies only for immediate/test tasks
	if (!isScheduledTask && cookies[taskKey]) {
		log(`Reusing valid cookie for task: ${taskKey}`);
		return cookies[taskKey];
	}

	log(`Performing fresh login for task: ${taskKey} (scheduled: ${isScheduledTask})`);

	const loginPayload = {
		dir,
		date: '',
		r: '',
		email,
		password,
		signin: 'Sign In',
	};

	try {
		const response = await axios.post(
			'https://holdmycourt.xyz/reserve2/reserve_signin.php',
			qs.stringify(loginPayload),
			{
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'User-Agent':
						'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
					Referer: `https://holdmycourt.xyz/reserve2/reserve_signin.php?dir=${dir}`,
				},
				maxRedirects: 0,
				validateStatus: (status) => status < 400,
			}
		);

		if (response.status === 302) {
			log('Login successful');
			const cookie = response.headers['set-cookie']?.map((c) => c.split(';')[0]).join('; ');
			log(`Login Cookie value: ${cookie}`);

			// Store cookie only for non-scheduled tasks
			if (!isScheduledTask) {
				cookies[taskKey] = cookie;
			}

			return cookie;
		} else {
			log(`Login failed with status: ${response.status}`);
			log(`Response headers: ${JSON.stringify(response.headers)}`);
			log(`Response data: ${JSON.stringify(response.data)}`);
			return null;
		}
	} catch (error) {
		log(`Login error: ${error.message}`);
		if (error.response) {
			log(`Login error response status: ${error.response.status}`);
			log(`Login error response data: ${JSON.stringify(error.response.data)}`);
		}
		throw error;
	}
}

// Reservation function
async function makeReservation(cookie, dir, reservationDetails) {
	const { date, hour, court, emailInfo, name } = reservationDetails;

	log(`Making reservation for: ${name} on ${date} at ${hour}:00 for court ${court}`);

	const reservationPayload = {
		dir,
		date,
		hour,
		court,
		email_info: emailInfo,
		view: '0',
		duration: 4, // maps to 1 hour
		name,
		submit: 'Submit',
	};

	log(`Reservation payload: ${JSON.stringify(reservationPayload)}`);

	try {
		const response = await axios.post(
			'https://holdmycourt.xyz/reserve2/reserve_form.php',
			qs.stringify(reservationPayload),
			{
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'User-Agent':
						'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
					Cookie: cookie,
					Referer: `https://holdmycourt.xyz/reserve2/reserve_form.php?date=${date}&hour=${hour}&court=${court}&dir=${dir}&view=0`,
				},
				maxRedirects: 0,
				validateStatus: (status) => status < 400,
			}
		);

		log(`Reservation response status: ${response.status}`);
		log(`Reservation response headers: ${JSON.stringify(response.headers)}`);

		if (response.status === 302) {
			log(`Reservation successful for ${reservationDetails.date}`);
		} else {
			log(`Reservation failed for ${reservationDetails.date}: ${response.status}`);
			log(`Response data: ${JSON.stringify(response.data)}`);
			log(`Cookie being used: ${cookie}`);
			throw new Error(`Reservation failed with status ${response.status}`);
		}
	} catch (error) {
		log(`Reservation error for ${reservationDetails.date}: ${error.message}`);
		if (error.response) {
			log(`Response status: ${error.response.status}`);
			log(`Response data: ${JSON.stringify(error.response.data)}`);
		}
		throw error;
	}
}

async function retryMakeReservation(cookie, dir, reservationDetails, retries = 3) {
	for (let attempt = 1; attempt <= retries; attempt++) {
		log(`Retry attempt ${attempt} for ${reservationDetails.date}`);
		// delay for 5 seconds before retry
		await new Promise((resolve) => setTimeout(resolve, 5000));
		try {
			await makeReservation(cookie, dir, reservationDetails);
			log(`Retry ${attempt} successful for ${reservationDetails.date}`);
			return; // Success, exit the function
		} catch (error) {
			log(`Retry ${attempt} failed: ${error.message}`);
			if (attempt === retries) {
				log(`All ${retries} retry attempts failed for ${reservationDetails.date}`);
				throw error; // Rethrow if out of retries
			}
		}
	}
}

async function handleBookingRequest(taskKey, email, password, dir, reservationDetails) {
	const targetDate = new Date(reservationDetails.date);
	const currentDate = new Date();
	const daysDifference = Math.ceil((targetDate - currentDate) / (1000 * 60 * 60 * 24));

	if (daysDifference < 0) {
		log(`Task ${taskKey} rejected: Target date ${reservationDetails.date} is in the past.`);
		return null;
	}

	// If within 7 days, attempt immediate booking
	if (daysDifference <= 7) {
		log(`Task ${taskKey}: Target date is within 7 days, attempting immediate booking...`);
		try {
			const cookie = await login(email, password, dir, taskKey);
			if (cookie) {
				try {
					await makeReservation(cookie, dir, reservationDetails);
					log(`Immediate booking successful for ${taskKey}`);
				} catch (reservationError) {
					log(`Immediate booking failed, attempting retry for ${taskKey}...`);
					await retryMakeReservation(cookie, dir, reservationDetails);
				}

				// If recurring, schedule future bookings
				if (reservationDetails.recurring === 'true') {
					const nextWeek = new Date(targetDate);
					nextWeek.setDate(targetDate.getDate() + 7);
					const nextReservationDetails = {
						...reservationDetails,
						date: nextWeek.toISOString().split('T')[0],
					};
					const nextTaskKey = `${reservationDetails.name}_${reservationDetails.hour}_${
						reservationDetails.court
					}_${Date.now()}`;

					// Schedule the next week's booking
					scheduleTask(nextTaskKey, email, password, dir, nextReservationDetails);
					log(`Next recurring reservation scheduled for ${nextReservationDetails.date}`);
				}

				return { immediate: true, success: true };
			}
		} catch (error) {
			log(`Immediate booking failed for ${taskKey}: ${error.message}`);
			return { immediate: true, success: false, error: error.message };
		}
	} else {
		// If outside 7 days, schedule it for the appropriate time
		return scheduleTask(taskKey, email, password, dir, reservationDetails);
	}
}

function scheduleTask(taskKey, email, password, dir, reservationDetails) {
	const targetDate = new Date(reservationDetails.date);

	// Calculate the exact run time (7 days before the target date at 12:01:00 AM in Dublin timezone)
	const bookingReleaseDate = new Date(targetDate);
	bookingReleaseDate.setDate(targetDate.getDate() - 7); // 7 days before the target date

	// For comparison purposes, compare just the dates (not times)
	const currentDate = new Date();
	const bookingReleaseDateOnly = new Date(
		bookingReleaseDate.getFullYear(),
		bookingReleaseDate.getMonth(),
		bookingReleaseDate.getDate()
	);
	const currentDateOnly = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());

	// Check if the booking release date is in the past (comparing just the date, not time)
	if (bookingReleaseDateOnly < currentDateOnly) {
		log(`Task ${taskKey} rejected: Booking release date ${bookingReleaseDate.toDateString()} is in the past.`);
		return null;
	}

	// Create a RecurrenceRule with timezone
	const rule = new schedule.RecurrenceRule();
	rule.tz = 'Europe/Dublin'; // Set timezone to Europe/Dublin
	rule.year = bookingReleaseDate.getFullYear();
	rule.month = bookingReleaseDate.getMonth(); // Zero-based
	rule.date = bookingReleaseDate.getDate();
	rule.hour = 0; // 12:01 AM
	rule.minute = 1;
	rule.second = 0;

	// Schedule the task
	const task = schedule.scheduleJob(rule, async () => {
		log(`Running scheduled task: ${taskKey} at ${new Date().toISOString()}`);
		try {
			// Fresh login for scheduled tasks (don't reuse cookies from other contexts)
			const scheduledTaskKey = `${taskKey}_scheduled`;
			const cookie = await login(email, password, dir, scheduledTaskKey);
			if (cookie) {
				try {
					await makeReservation(cookie, dir, reservationDetails);
					log(`Scheduled task ${taskKey} completed successfully`);
				} catch (reservationError) {
					log(`Scheduled task ${taskKey} reservation failed, attempting retry...`);
					await retryMakeReservation(cookie, dir, reservationDetails);
				}

				// If recurring, schedule the next week's booking
				if (reservationDetails.recurring === 'true') {
					const nextWeek = new Date(targetDate);
					nextWeek.setDate(targetDate.getDate() + 7);
					const nextReservationDetails = {
						...reservationDetails,
						date: nextWeek.toISOString().split('T')[0],
					};
					const nextTaskKey = `${reservationDetails.name}_${reservationDetails.hour}_${
						reservationDetails.court
					}_${Date.now()}`;

					// Schedule the next week's booking
					scheduleTask(nextTaskKey, email, password, dir, nextReservationDetails);
					log(`Next recurring reservation scheduled for ${nextReservationDetails.date}`);
				}
			} else {
				log(`Login failed for scheduled task ${taskKey}`);
			}
		} catch (error) {
			log(`Task ${taskKey} failed: ${error.message}`);
		}
	});

	// Add the task to the task list
	tasks.push({ key: taskKey, task });
	log(`Task ${taskKey} scheduled for ${bookingReleaseDate.toDateString()} 00:01:00 (timezone: Europe/Dublin)`);
	return task;
}

// API routes
app.use(bodyParser.json());
app.use(express.static('public'));

app.get('/logs', (req, res) => {
	res.json(logs);
});

app.post('/start', async (req, res) => {
	const { date, hour, court, emailInfo, name, recurring } = req.body;
	const reservationDetails = { date, hour, court, emailInfo, name, recurring };

	const email = process.env.EMAIL;
	const password = process.env.PASSWORD;
	const dir = process.env.DIR;
	const taskKey = `${name}_${hour}_${court}_${Date.now()}`; // Unique task identifier

	try {
		const result = await handleBookingRequest(taskKey, email, password, dir, reservationDetails);
		if (!result) {
			res.status(400).send({ message: `Task ${taskKey} could not be processed. Check logs for details.` });
		} else if (result.immediate) {
			if (result.success) {
				res.send({ message: `Immediate booking successful for ${reservationDetails.date}` });
			} else {
				res.status(400).send({ message: `Immediate booking failed: ${result.error}` });
			}
		} else {
			res.send({ message: `Task ${taskKey} scheduled successfully` });
		}
	} catch (error) {
		log(`Error processing booking request: ${error.message}`);
		res.status(500).send({ message: `Error processing booking request: ${error.message}` });
	}
});

app.post('/stop', (req, res) => {
	const { taskKey } = req.body;

	// Find the task by taskKey
	const taskIndex = tasks.findIndex((t) => t.key === taskKey);

	// Log current task keys
	log(`Current task keys: ${tasks.map((t) => t.key).join(', ')}`);

	// Handle case where taskKey is not found
	if (taskIndex >= 0) {
		const task = tasks[taskIndex].task;
		if (task) {
			task.cancel(); // Safely cancel the task
			tasks.splice(taskIndex, 1); // Remove the task from the list
			log(`Task ${taskKey} stopped.`);
			res.send({ message: `Task ${taskKey} stopped successfully` });
		} else {
			log(`Task ${taskKey} exists but has no active schedule.`);
			res.status(400).send({ message: `Task ${taskKey} has no active schedule to cancel` });
		}
	} else {
		log(`Task ${taskKey} not found.`);
		res.status(400).send({ message: `Task ${taskKey} not found` });
	}
});

app.post('/test', async (req, res) => {
	const { date, hour, court, emailInfo, name } = req.body;
	const reservationDetails = { date, hour, court, emailInfo, name };

	const email = process.env.EMAIL;
	const password = process.env.PASSWORD;
	const dir = process.env.DIR;
	const taskKey = `${name}_${hour}_${court}`; // Unique task identifier for logging/debugging

	try {
		log(`Running test reservation task: ${taskKey}`);
		const cookie = await login(email, password, dir, taskKey);
		if (cookie) {
			try {
				await makeReservation(cookie, dir, reservationDetails);
				res.send({ message: `Test reservation successful for ${reservationDetails.date}` });
			} catch (reservationError) {
				log(`Test reservation failed, attempting retry for ${taskKey}...`);
				await retryMakeReservation(cookie, dir, reservationDetails);
				res.send({ message: `Test reservation successful for ${reservationDetails.date} (after retry)` });
			}
		} else {
			res.status(400).send({ message: 'Login failed during test' });
		}
	} catch (error) {
		log(`Test task failed: ${error.message}`);
		res.status(500).send({ message: `Test failed: ${error.message}` });
	}
});

app.get('/tasks', (req, res) => {
	res.json(tasks.map((t) => t.key));
});

// Start server
if (
	fs.existsSync(path.join(__dirname, 'certs', 'key.pem')) &&
	fs.existsSync(path.join(__dirname, 'certs', 'cert.pem'))
) {
	// Create HTTPS server
	https.createServer({ key, cert }, app).listen(PORT, () => {
		log(`Server is running on https://localhost:${PORT}`);
	});
} else {
	// Fallback to HTTP server
	app.listen(PORT, () => {
		log(`Server running on http://localhost:${PORT}`);
	});
}
