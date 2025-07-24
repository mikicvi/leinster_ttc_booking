/**
 * @fileoverview Task and statistics API routes
 * Handles endpoints for viewing active tasks and system statistics
 *
 * @module routes/tasks
 * @author Leinster TTC Booking Team
 * @license MIT
 */

const express = require('express');
const router = express.Router();

/**
 * Sets up task routes with dependency injection
 *
 * @param {Object} dependencies - Required dependencies
 * @param {Object} dependencies.scheduleManager - Schedule manager instance
 * @param {Object} dependencies.dbManager - Database manager instance
 * @param {Function} dependencies.log - Logging function
 * @returns {express.Router} Configured router
 */
function setupTaskRoutes({ scheduleManager, dbManager, log }) {
	/**
	 * API endpoint to get all active scheduled tasks
	 *
	 * @route GET /tasks
	 * @returns {Object} Response with list of active tasks and count
	 */
	router.get('/', async (req, res) => {
		try {
			// Get active bookings from schedule manager
			const activeBookings = await scheduleManager.getActiveBookings();

			res.json({
				active: activeBookings.bookings.map((b) => b.task_key),
				count: activeBookings.count,
				source: 'database',
			});
		} catch (error) {
			await log(`Error getting tasks: ${error.message}`, 'error');
			res.status(500).json({
				active: [],
				count: 0,
				error: error.message,
			});
		}
	});

	/**
	 * API endpoint to get system statistics
	 *
	 * @route GET /stats
	 * @returns {Object} Response with database and schedule statistics
	 */
	router.get('/stats', async (req, res) => {
		try {
			const stats = await dbManager.getStats();
			const scheduleStats = {
				activeSchedules: scheduleManager ? scheduleManager.getActiveTaskKeys().length : 0,
			};

			res.json({
				...stats,
				...scheduleStats,
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			res.status(500).json({
				error: 'Failed to get statistics',
				message: error.message,
			});
		}
	});

	/**
	 * API endpoint to get recent logs with pagination
	 *
	 * @route GET /logs
	 * @query {number} page - Page number (1-based, default: 1)
	 * @query {number} limit - Items per page (default: 15, max: 100)
	 * @returns {Object} Response with formatted log messages and pagination info
	 */
	router.get('/logs', async (req, res) => {
		try {
			const page = Math.max(1, parseInt(req.query.page) || 1);
			const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 15));
			const offset = (page - 1) * limit;

			// Get total count first
			const totalCount = await dbManager.getLogsCount();

			// Get paginated logs
			const logs = await dbManager.getPaginatedLogs(limit, offset);

			// Format logs for frontend display
			const formattedLogs = logs.map((log) => {
				const timestamp = new Date(log.timestamp).toISOString();
				const taskKeyInfo = log.task_key ? ` [${log.task_key}]` : '';
				return `[${timestamp}] ${log.level.toUpperCase()}${taskKeyInfo}: ${log.message}`;
			});

			const totalPages = Math.ceil(totalCount / limit);

			res.json({
				logs: formattedLogs,
				pagination: {
					page,
					limit,
					totalCount,
					totalPages,
					hasNext: page < totalPages,
					hasPrev: page > 1,
				},
			});
		} catch (error) {
			await log(`Error getting logs: ${error.message}`, 'error');
			res.status(500).json({
				error: 'Failed to get logs',
				message: error.message,
			});
		}
	});

	return router;
}

module.exports = setupTaskRoutes;
