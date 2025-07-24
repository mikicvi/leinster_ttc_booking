/**
 * @fileoverview Main application file for Leinster TTC Booking
 * Handles HTTP server setup, API routes, and booking coordination.
 *
 * This is the main entry point for the application that coordinates the booking system.
 * It sets up the Express server, initializes the database connection, and manages
 * the booking schedules.
 *
 * @module index
 * @author Leinster TTC Booking Team
 * @license MIT
 */

const express = require('express');
const bodyParser = require('body-parser');
const schedule = require('node-schedule');
const axios = require('axios');
const qs = require('qs');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Import our modules
const DatabaseManager = require('./lib/database');
const ScheduleManager = require('./lib/scheduleManager');
const { config, validateConfig } = require('../config');
const { setupBookingRoutes, setupTaskRoutes } = require('./routes');

const app = express();
const PORT = config.server.port;

// Validate configuration
const configValidation = validateConfig();
if (!configValidation.valid) {
	console.error('Configuration validation failed. Missing required values:', configValidation.missing);
	process.exit(1);
}

// SSL Certificate
let key, cert;
if (fs.existsSync(config.ssl.keyPath) && fs.existsSync(config.ssl.certPath)) {
	key = fs.readFileSync(config.ssl.keyPath);
	cert = fs.readFileSync(config.ssl.certPath);
}

// Initialize database and schedule manager
const dbManager = new DatabaseManager();
let scheduleManager;
const logs = [];
let cookies = {}; // Store cookies by task key

/**
 * Log a message to console, in-memory log, and database
 * @param {string} message - The message to log
 * @param {string} [level='info'] - Log level (info, warn, error, debug)
 * @param {string|null} [taskKey=null] - Associated task key, if any
 * @param {string|null} [details=null] - Additional details (typically JSON string)
 * @returns {Promise<void>}
 */
async function log(message, level = 'info', taskKey = null, details = null) {
	const timestamp = new Date().toISOString();
	const logEntry = `[${timestamp}] ${message}`;
	logs.push(logEntry);
	console.log(logEntry);

	// Also log to database if available
	if (dbManager && dbManager.db) {
		try {
			await dbManager.logToDatabase(level, message, taskKey, details);
		} catch (error) {
			console.error('Failed to log to database:', error.message);
		}
	}
}

/**
 * Authenticates with the booking service and manages cookie sessions
 *
 * @param {string} email - User email for authentication
 * @param {string} password - User password for authentication
 * @param {string} dir - Directory parameter for the booking service
 * @param {string} taskKey - Unique task identifier for tracking
 * @returns {Promise<string|null>} - Session cookie if login successful, null otherwise
 */
async function login(email, password, dir, taskKey) {
	// For scheduled tasks, always get a fresh login to avoid cookie expiration issues
	const isScheduledTask = taskKey.includes('_scheduled');

	// Reuse valid cookies only for immediate/test tasks
	if (!isScheduledTask && cookies[taskKey]) {
		await log(`Reusing valid cookie for task: ${taskKey}`, 'info', taskKey);
		return cookies[taskKey];
	}

	await log(`Performing fresh login for task: ${taskKey} (scheduled: ${isScheduledTask})`, 'info', taskKey);

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
			await log('Login successful', 'info', taskKey);
			const cookie = response.headers['set-cookie']?.map((c) => c.split(';')[0]).join('; ');
			await log(`Login Cookie value: ${cookie}`, 'debug', taskKey);

			// Store cookie only for non-scheduled tasks
			if (!isScheduledTask) {
				cookies[taskKey] = cookie;
			}

			return cookie;
		} else {
			await log(`Login failed with status: ${response.status}`, 'error', taskKey);
			await log(`Response headers: ${JSON.stringify(response.headers)}`, 'debug', taskKey);
			await log(`Response data: ${JSON.stringify(response.data)}`, 'debug', taskKey);
			return null;
		}
	} catch (error) {
		await log(`Login error: ${error.message}`, 'error', taskKey, JSON.stringify({ stack: error.stack }));
		if (error.response) {
			await log(`Login error response status: ${error.response.status}`, 'error', taskKey);
			await log(`Login error response data: ${JSON.stringify(error.response.data)}`, 'debug', taskKey);
		}
		throw error;
	}
}

/**
 * Creates a court reservation with the provided details
 *
 * @param {string} cookie - Authentication cookie from login
 * @param {string} dir - Directory parameter for the booking service
 * @param {Object} reservationDetails - Court booking details
 * @param {string} reservationDetails.date - Date for reservation (YYYY-MM-DD)
 * @param {string|number} reservationDetails.hour - Hour for reservation
 * @param {string|number} reservationDetails.court - Court number
 * @param {string} reservationDetails.emailInfo - Additional email information
 * @param {string} reservationDetails.name - Name for the reservation
 * @param {string} [taskKey=null] - Task identifier for logging
 * @returns {Promise<void>}
 * @throws {Error} If reservation fails
 */
async function makeReservation(cookie, dir, reservationDetails, taskKey = null) {
	const { date, hour, court, emailInfo, name } = reservationDetails;

	await log(`Making reservation for: ${name} on ${date} at ${hour}:00 for court ${court}`, 'info', taskKey);

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

	await log(`Reservation payload: ${JSON.stringify(reservationPayload)}`, 'debug', taskKey);

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

		await log(`Reservation response status: ${response.status}`, 'info', taskKey);
		await log(`Reservation response headers: ${JSON.stringify(response.headers)}`, 'debug', taskKey);

		if (response.status === 302) {
			await log(`Reservation successful for ${reservationDetails.date}`, 'info', taskKey);
		} else {
			await log(`Reservation failed for ${reservationDetails.date}: ${response.status}`, 'error', taskKey);
			await log(`Response data: ${JSON.stringify(response.data)}`, 'debug', taskKey);
			await log(`Cookie being used: ${cookie}`, 'debug', taskKey);
			throw new Error(`Reservation failed with status ${response.status}`);
		}
	} catch (error) {
		await log(
			`Reservation error for ${reservationDetails.date}: ${error.message}`,
			'error',
			taskKey,
			JSON.stringify({ stack: error.stack })
		);
		if (error.response) {
			await log(`Response status: ${error.response.status}`, 'error', taskKey);
			await log(`Response data: ${JSON.stringify(error.response.data)}`, 'debug', taskKey);
		}
		throw error;
	}
}

/**
 * Attempts to make a reservation multiple times in case of failure
 *
 * @param {string} cookie - Authentication cookie from login
 * @param {string} dir - Directory parameter for the booking service
 * @param {Object} reservationDetails - Court booking details
 * @param {string} [taskKey=null] - Task identifier for logging
 * @param {number} [retries=3] - Number of retry attempts
 * @returns {Promise<void>}
 * @throws {Error} If all retry attempts fail
 */
async function retryMakeReservation(
	cookie,
	dir,
	reservationDetails,
	taskKey = null,
	retries = config.app.retryAttempts
) {
	for (let attempt = 1; attempt <= retries; attempt++) {
		await log(`Retry attempt ${attempt} for ${reservationDetails.date}`, 'info', taskKey);
		// delay for retry
		await new Promise((resolve) => setTimeout(resolve, config.app.retryDelay));
		try {
			await makeReservation(cookie, dir, reservationDetails, taskKey);
			await log(`Retry ${attempt} successful for ${reservationDetails.date}`, 'info', taskKey);
			return; // Success, exit the function
		} catch (error) {
			await log(`Retry ${attempt} failed: ${error.message}`, 'error', taskKey);
			if (attempt === retries) {
				await log(`All ${retries} retry attempts failed for ${reservationDetails.date}`, 'error', taskKey);
				throw error; // Rethrow if out of retries
			}
		}
	}
}

/**
 * Collection of handlers for processing bookings
 * Used by the ScheduleManager to execute booking operations
 *
 * @type {Object}
 */
const bookingHandlers = {
	/**
	 * Handles a new booking request by determining if it should be executed immediately or scheduled
	 *
	 * @param {string} taskKey - Unique task identifier
	 * @param {string} email - User email for authentication
	 * @param {string} password - User password for authentication
	 * @param {string} dir - Directory parameter for the booking service
	 * @param {Object} reservationDetails - Court booking details
	 * @returns {Promise<Object|null>} - Result of booking operation or null if rejected
	 */
	handleBookingRequest: async function (taskKey, email, password, dir, reservationDetails) {
		return await handleBookingRequest(taskKey, email, password, dir, reservationDetails);
	},
	/**
	 * Executes a booking operation with the booking service
	 *
	 * @param {string} email - User email for authentication
	 * @param {string} password - User password for authentication
	 * @param {string} dir - Directory parameter for the booking service
	 * @param {Object} reservationDetails - Court booking details
	 * @param {string} taskKey - Unique task identifier for tracking
	 * @returns {Promise<Object>} - Result with success status and error if applicable
	 */
	executeBooking: async function (email, password, dir, reservationDetails, taskKey) {
		try {
			const cookie = await login(email, password, dir, `${taskKey}_scheduled`);
			if (cookie) {
				try {
					await makeReservation(cookie, dir, reservationDetails, taskKey);
					return { success: true };
				} catch (reservationError) {
					await log(`Scheduled booking failed, attempting retry for ${taskKey}...`, 'warn', taskKey);
					await retryMakeReservation(cookie, dir, reservationDetails, taskKey);
					return { success: true };
				}
			} else {
				return { success: false, error: 'Login failed' };
			}
		} catch (error) {
			return { success: false, error: error.message };
		}
	},
};

/**
 * Processes a booking request, determining whether to execute immediately or schedule
 * based on the booking date
 *
 * @param {string} taskKey - Unique task identifier for tracking
 * @param {string} email - User email for authentication
 * @param {string} password - User password for authentication
 * @param {string} dir - Directory parameter for the booking service
 * @param {Object} reservationDetails - Court booking details
 * @param {string} reservationDetails.date - Date for reservation (YYYY-MM-DD)
 * @param {string|number} reservationDetails.hour - Hour for reservation
 * @param {string|number} reservationDetails.court - Court number
 * @param {string} [reservationDetails.emailInfo] - Additional email information
 * @param {string} reservationDetails.name - Name for the reservation
 * @param {boolean|string} [reservationDetails.recurring] - Whether this is a recurring booking
 * @returns {Promise<Object|null>} - Result of booking operation or null if rejected
 */
async function handleBookingRequest(taskKey, email, password, dir, reservationDetails) {
	const targetDate = new Date(reservationDetails.date);
	const currentDate = new Date();
	const daysDifference = Math.ceil((targetDate - currentDate) / (1000 * 60 * 60 * 24));

	if (daysDifference < 0) {
		await log(`Task ${taskKey} rejected: Target date ${reservationDetails.date} is in the past.`, 'warn', taskKey);
		return null;
	}

	// Make sure email_info is always defined to prevent NOT NULL constraints
	const emailInfo =
		reservationDetails.emailInfo || `Hall Tb ${reservationDetails.court} at ${reservationDetails.hour}:00`;

	// Save booking to database
	try {
		const scheduledRunTime =
			daysDifference > config.app.bookingAdvanceDays
				? scheduleManager.calculateScheduledRunTime(targetDate)
				: null;

		await dbManager.saveBooking({
			taskKey,
			name: reservationDetails.name,
			email,
			password,
			dir,
			date: reservationDetails.date,
			hour: parseInt(reservationDetails.hour),
			court: parseInt(reservationDetails.court),
			emailInfo: emailInfo,
			recurring: reservationDetails.recurring === 'true',
			status: daysDifference <= config.app.bookingAdvanceDays ? 'pending' : 'scheduled',
			scheduledRunTime: scheduledRunTime ? scheduledRunTime.toISOString() : null,
		});
	} catch (dbError) {
		await log(`Failed to save booking to database: ${dbError.message}`, 'error', taskKey);
		throw dbError;
	}

	// If within booking advance days, attempt immediate booking
	if (daysDifference <= config.app.bookingAdvanceDays) {
		await log(
			`Task ${taskKey}: Target date is within ${config.app.bookingAdvanceDays} days, attempting immediate booking...`,
			'info',
			taskKey
		);
		try {
			const cookie = await login(email, password, dir, taskKey);
			if (cookie) {
				try {
					await makeReservation(cookie, dir, reservationDetails, taskKey);
					await log(`Immediate booking successful for ${taskKey}`, 'info', taskKey);
					await dbManager.updateBookingStatus(taskKey, 'completed', new Date().toISOString());
				} catch (reservationError) {
					await log(`Immediate booking failed, attempting retry for ${taskKey}...`, 'warn', taskKey);
					await retryMakeReservation(cookie, dir, reservationDetails, taskKey);
					await dbManager.updateBookingStatus(taskKey, 'completed', new Date().toISOString());
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

					// Save the next recurring booking to the database before scheduling
					const nextScheduledRunTime = scheduleManager.calculateScheduledRunTime(
						new Date(nextReservationDetails.date)
					);
					await dbManager.saveBooking({
						taskKey: nextTaskKey,
						name: nextReservationDetails.name,
						email,
						password,
						dir,
						date: nextReservationDetails.date,
						hour: parseInt(nextReservationDetails.hour),
						court: parseInt(nextReservationDetails.court),
						emailInfo: emailInfo,
						recurring: true,
						status: 'scheduled',
						scheduledRunTime: nextScheduledRunTime.toISOString(),
					});

					// Schedule the next recurring booking
					await scheduleManager.scheduleBooking(nextTaskKey, nextScheduledRunTime, nextReservationDetails);
				}

				return { success: true, attempted: true };
			} else {
				await log(`Immediate booking failed for ${taskKey}: Could not authenticate`, 'error', taskKey);
				await dbManager.updateBookingStatus(taskKey, 'failed', new Date().toISOString());
				return { success: false, attempted: true, error: 'Authentication failed' };
			}
		} catch (error) {
			await log(`Immediate booking error for ${taskKey}: ${error.message}`, 'error', taskKey);
			await dbManager.updateBookingStatus(taskKey, 'failed', new Date().toISOString());
			return { success: false, attempted: true, error: error.message };
		}
	} else {
		// Schedule for later execution
		const scheduledRunTime = scheduleManager.calculateScheduledRunTime(targetDate);
		await scheduleManager.scheduleBooking(taskKey, scheduledRunTime, reservationDetails);
		await log(`Task ${taskKey} scheduled for ${scheduledRunTime.toISOString()}`, 'info', taskKey);
		return { success: true, scheduled: true, scheduledRunTime: scheduledRunTime.toISOString() };
	}
}

/**
 * Initializes the application by setting up the database, recreating schedules,
 * and configuring periodic cleanup tasks
 *
 * @returns {Promise<void>}
 * @throws {Error} If initialization fails
 */
async function initializeApp() {
	try {
		await dbManager.initialize();
		await log('Database initialized successfully', 'info');

		// Initialize schedule manager with booking handlers
		scheduleManager = new ScheduleManager(dbManager, bookingHandlers);

		// Recreate schedules from database
		const recreationResult = await scheduleManager.recreateSchedulesFromDatabase();

		// Log task counts
		await log(`Application initialization complete. ${recreationResult.recreated} schedules recreated.`, 'info');

		// Show task details after initialization
		const scheduleManagerTaskKeys = scheduleManager.getActiveTaskKeys();
		await log(`After initialization - Schedule manager tasks: ${scheduleManagerTaskKeys.length}`, 'info');

		// Set up periodic cleanup
		setInterval(async () => {
			try {
				await dbManager.cleanupLogs();
				await scheduleManager.cleanupExpiredSchedules();
				await log('Periodic cleanup completed', 'info');
			} catch (error) {
				await log(`Periodic cleanup failed: ${error.message}`, 'error');
			}
		}, config.app.cleanupInterval);

		// Set up routes after initialization
		const dependencies = { scheduleManager, dbManager, log };
		app.use('/api/bookings', setupBookingRoutes(dependencies));
		app.use('/api/tasks', setupTaskRoutes(dependencies));

		// Legacy route compatibility
		app.post('/start', (req, res) => {
			req.url = '/api/bookings';
			req.method = 'POST';
			app.handle(req, res);
		});

		app.post('/stop', (req, res) => {
			const { taskKey } = req.body;
			req.url = `/api/bookings/${taskKey}`;
			req.method = 'DELETE';
			app.handle(req, res);
		});

		app.get('/tasks', (req, res) => {
			req.url = '/api/tasks';
			app.handle(req, res);
		});

		app.get('/stats', (req, res) => {
			req.url = '/api/tasks/stats';
			app.handle(req, res);
		});

		app.get('/bookings', (req, res) => {
			req.url = '/api/bookings';
			app.handle(req, res);
		});

		app.get('/logs', (req, res) => {
			req.url = '/api/tasks/logs';
			app.handle(req, res);
		});
	} catch (error) {
		console.error('Failed to initialize application:', error);
		process.exit(1);
	}
}

// API middleware setup
app.use(bodyParser.json());
app.use(express.static('public'));

/**
 * Starts the HTTP or HTTPS server after initializing the application
 * Uses HTTPS if certificates are available, otherwise falls back to HTTP
 *
 * @returns {Promise<void>}
 */
async function startServer() {
	try {
		// Initialize database and schedules first
		await initializeApp();

		// Check for SSL certificates
		const useHttps = key && cert;

		if (useHttps) {
			// Create HTTPS server
			https.createServer({ key, cert }, app).listen(PORT, () => {
				log(`Server is running on https://localhost:${PORT}`, 'info');
			});
		} else {
			// Fallback to HTTP server
			app.listen(PORT, () => {
				log(`Server running on http://localhost:${PORT}`, 'info');
			});
		}
	} catch (error) {
		console.error('Failed to start server:', error);
		process.exit(1);
	}
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
	console.log('\nShutting down gracefully...');

	// Log active tasks before shutdown
	if (scheduleManager) {
		const activeTasks = scheduleManager.getActiveTaskKeys();
		console.log(`Active tasks before shutdown: ${activeTasks.length}`);
	}

	// Close database connection
	if (dbManager) {
		dbManager.close();
	}

	process.exit(0);
});

process.on('SIGTERM', async () => {
	console.log('\nShutting down gracefully...');

	// Log active tasks before shutdown
	if (scheduleManager) {
		const activeTasks = scheduleManager.getActiveTaskKeys();
		console.log(`Active tasks before shutdown: ${activeTasks.length}`);
	}

	// Close database connection
	if (dbManager) {
		dbManager.close();
	}

	process.exit(0);
});

// Start the application
startServer().catch((error) => {
	console.error('Failed to start server:', error);
	process.exit(1);
});
