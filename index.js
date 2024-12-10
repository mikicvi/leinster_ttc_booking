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
	// Reuse valid cookies
	if (cookies[taskKey]) {
		log(`Reusing valid cookie for task:, ${taskKey}`);
		return cookies[taskKey];
	}

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
					Referer: `https://holdmycourt.xyz/reserve2/reserve_signin.php?dir=${dir}`,
				},
				maxRedirects: 0,
				validateStatus: (status) => status < 400,
			}
		);

		if (response.status === 302) {
			log('Login successful');
			const cookie = response.headers['set-cookie']?.map((c) => c.split(';')[0]).join('; ');
			cookies[taskKey] = cookie; // Save cookie
			return cookie;
		} else {
			log('Login failed');
			return null;
		}
	} catch (error) {
		log(`Login error: ${error.message}`);
		throw error;
	}
}

// Reservation function
async function makeReservation(cookie, dir, reservationDetails) {
	const { date, hour, court, emailInfo, name } = reservationDetails;

	const reservationPayload = {
		dir,
		date,
		hour,
		court,
		email_info: emailInfo,
		view: '0',
		duration: 4,
		name,
		submit: 'Submit',
	};

	try {
		const response = await axios.post(
			'https://holdmycourt.xyz/reserve2/reserve_form.php',
			qs.stringify(reservationPayload),
			{
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Cookie: cookie,
					Referer: `https://holdmycourt.xyz/reserve2/reserve_form.php?date=${date}&hour=${hour}&court=${court}&dir=${dir}&view=0`,
				},
				maxRedirects: 0,
				validateStatus: (status) => status < 400,
			}
		);

		if (response.status === 302) {
			log(`Reservation successful for ${reservationDetails.date}`);
		} else {
			log(`Reservation failed for ${reservationDetails.date}: ${response.status}`);
			log(`Response data: ${JSON.stringify(response.data)}`);
			retryMakeReservation(dir, reservationDetails);
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

async function retryMakeReservation(dir, reservationDetails, retries = 3) {
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const cookie = await login(email, password, dir, taskKey);
			const res = await makeReservation(cookie, dir, reservationDetails);
			return res; // Success, exit the function
		} catch (error) {
			log(`Retry ${attempt} failed: ${error.message}`);
			if (attempt === retries) throw error; // Rethrow if out of retries
		}
	}
}

function scheduleTask(taskKey, email, password, dir, reservationDetails) {
	// Calculate the exact run time (7 days before the target date at 12:00:20 AM in the specified timezone)
	const targetDate = new Date(reservationDetails.date);
	const bookingReleaseDate = new Date(targetDate);
	bookingReleaseDate.setDate(targetDate.getDate() - 7); // 7 days before the target date
	bookingReleaseDate.setHours(0, 0, 20, 0); // Set time to 12:00:20 AM

	// Create a RecurrenceRule with timezone
	const rule = new schedule.RecurrenceRule();
	rule.tz = 'Europe/Dublin'; // Set timezone to Europe/Dublin
	rule.year = bookingReleaseDate.getUTCFullYear();
	rule.month = bookingReleaseDate.getUTCMonth(); // Zero-based
	rule.date = bookingReleaseDate.getUTCDate();
	rule.hour = bookingReleaseDate.getUTCHours();
	rule.minute = bookingReleaseDate.getUTCMinutes();
	rule.second = bookingReleaseDate.getUTCSeconds();

	// Schedule the task
	const task = schedule.scheduleJob(rule, async () => {
		log(`Running scheduled task: ${taskKey} at ${new Date().toISOString()}`);
		try {
			const cookie = await login(email, password, dir, taskKey);
			if (cookie) {
				await makeReservation(cookie, dir, reservationDetails);

				// If recurring, calculate the next week's target date
				console.log(`recurring: ${reservationDetails.recurring}`);
				if (reservationDetails.recurring == 'true') {
					const nextWeek = new Date(targetDate);
					nextWeek.setDate(targetDate.getDate() + 7);
					reservationDetails.date = nextWeek.toISOString().split('T')[0];

					// Reschedule the task for the next week
					scheduleTask(taskKey, email, password, dir, reservationDetails);
					log(`Next reservation for ${taskKey} set for ${reservationDetails.date}`);
				}
			}
		} catch (error) {
			log(`Task ${taskKey} failed: ${error.message}`);
		}
	});

	// Add the task to the task list
	tasks.push({ key: taskKey, task });
	log(`Task ${taskKey} scheduled for ${bookingReleaseDate.toISOString()} (timezone: Europe/Dublin)`);
}

// API routes
app.use(bodyParser.json());
app.use(express.static('public'));

app.get('/logs', (req, res) => {
	res.json(logs);
});

app.post('/start', (req, res) => {
	const { date, hour, court, emailInfo, name, recurring } = req.body;
	const reservationDetails = { date, hour, court, emailInfo, name, recurring };

	const email = process.env.EMAIL;
	const password = process.env.PASSWORD;
	const dir = process.env.DIR;
	const taskKey = `${name}_${hour}_${court}_${Date.now()}`; // Unique task identifier

	scheduleTask(taskKey, email, password, dir, reservationDetails);
	res.send({ message: `Task ${taskKey} scheduled successfully` });
});

app.post('/stop', (req, res) => {
	const { taskKey } = req.body;

	// Find the task by taskKey
	const taskIndex = tasks.findIndex((t) => t.key === taskKey);

	// Log current tasks array
	log(`Current tasks: ${JSON.stringify(tasks)}`);

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
			await makeReservation(cookie, dir, reservationDetails);
			res.send({ message: `Test reservation successful for ${reservationDetails.date}` });
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
