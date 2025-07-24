/**
 * @fileoverview Booking API routes
 * Handles all booking-related API endpoints including creation, cancellation, and retrieval
 *
 * @module routes/bookings
 * @author Leinster TTC Booking Team
 * @license MIT
 */

const express = require('express');
const router = express.Router();

/**
 * Sets up booking routes with dependency injection
 *
 * @param {Object} dependencies - Required dependencies
 * @param {Object} dependencies.scheduleManager - Schedule manager instance
 * @param {Object} dependencies.dbManager - Database manager instance
 * @param {Function} dependencies.log - Logging function
 * @returns {express.Router} Configured router
 */
function setupBookingRoutes({ scheduleManager, dbManager, log }) {
	/**
	 * API endpoint to create a new booking
	 *
	 * @route POST /bookings
	 * @param {Object} req.body - The booking details
	 * @param {string} req.body.date - Date for reservation (YYYY-MM-DD)
	 * @param {string|number} req.body.hour - Hour for reservation
	 * @param {string|number} req.body.court - Court number
	 * @param {string} [req.body.emailInfo] - Additional email information
	 * @param {string} req.body.name - Name for the reservation
	 * @param {boolean|string} [req.body.recurring] - Whether this is a recurring booking
	 * @returns {Object} Response with message and taskKey
	 */
	router.post('/', async (req, res) => {
		const { date, hour, court, emailInfo, name, recurring } = req.body;

		// Validate required parameters
		if (!date || !hour || !court || !name) {
			return res.status(400).send({
				message: 'Missing required parameters. Please provide date, hour, court, and name.',
			});
		}

		const email = process.env.EMAIL;
		const password = process.env.PASSWORD;
		const dir = process.env.DIR;

		try {
			// Make sure email_info is always defined
			const emailInfoToUse = emailInfo || `Hall Tb ${court} at ${hour}:00`;

			// Create booking data object
			const bookingData = {
				taskKey: `${name}_${hour}_${court}_${Date.now()}`, // Unique task identifier
				name,
				email,
				password,
				dir,
				date,
				hour,
				court,
				emailInfo: emailInfoToUse,
				recurring: recurring === true || recurring === 'true',
				status: 'scheduled',
			};

			// Let schedule manager handle the booking creation
			const result = await scheduleManager.createBooking(bookingData);

			await log(`New booking created with key: ${result.taskKey}`, 'info', result.taskKey);

			res.send({
				message: `Booking successfully created for ${date}`,
				taskKey: result.taskKey,
			});
		} catch (error) {
			await log(`Error creating booking: ${error.message}`, 'error');
			res.status(500).send({ message: `Error creating booking: ${error.message}` });
		}
	});

	/**
	 * API endpoint to cancel a scheduled booking
	 *
	 * @route DELETE /bookings/:taskKey
	 * @param {string} req.params.taskKey - The unique task key to cancel
	 * @returns {Object} Response with success or error message
	 */
	router.delete('/:taskKey', async (req, res) => {
		const { taskKey } = req.params;

		if (!taskKey) {
			return res.status(400).send({ message: 'Missing required parameter: taskKey' });
		}

		try {
			// Let the schedule manager handle task cancellation
			const cancelled = await scheduleManager.cancelScheduledTask(taskKey);

			if (cancelled) {
				return res.send({ message: `Task ${taskKey} cancelled successfully` });
			}

			// Check if the task exists in the database even if not active
			const booking = await scheduleManager.getBookingDetails(taskKey);
			if (booking) {
				// Update database status manually
				await dbManager.updateBookingStatus(taskKey, 'cancelled');
				await log(`Task ${taskKey} found in database but not active. Marked as cancelled.`, 'warn', taskKey);
				return res.send({ message: `Task ${taskKey} found in database and marked as cancelled` });
			}

			// Task not found anywhere
			await log(`Task ${taskKey} not found in schedule manager or database.`, 'warn', taskKey);
			return res.status(404).send({ message: `Task ${taskKey} not found` });
		} catch (error) {
			await log(`Error cancelling task ${taskKey}: ${error.message}`, 'error', taskKey);
			return res.status(500).send({ message: `Error cancelling task: ${error.message}` });
		}
	});

	/**
	 * API endpoint to get booking history
	 *
	 * @route GET /bookings
	 * @param {Object} req.query - Query parameters
	 * @param {string} [req.query.status] - Filter by booking status
	 * @param {number} [req.query.limit=50] - Maximum number of bookings to return
	 * @returns {Array<Object>} List of bookings
	 */
	router.get('/', async (req, res) => {
		try {
			const { status, limit = 50 } = req.query;
			let sql = 'SELECT * FROM bookings';
			let params = [];

			if (status) {
				sql += ' WHERE status = ?';
				params.push(status);
			}

			sql += ' ORDER BY created_at DESC LIMIT ?';
			params.push(parseInt(limit));

			const bookings = await dbManager.getAllQuery(sql, params);
			res.json(bookings);
		} catch (error) {
			res.status(500).json({
				error: 'Failed to get bookings',
				message: error.message,
			});
		}
	});

	return router;
}

module.exports = setupBookingRoutes;
