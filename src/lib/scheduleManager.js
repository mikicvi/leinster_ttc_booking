/**
 * @fileoverview Schedule Manager for Leinster TTC Booking Application
 * Manages scheduling, execution, and tracking of booking tasks.
 * @module scheduleManager
 */

const schedule = require('node-schedule');

/**
 * Manages scheduling and execution of booking tasks
 */
class ScheduleManager {
	/**
	 * Creates a new ScheduleManager instance
	 * @param {Object} dbManager - Database manager instance
	 * @param {Object} bookingHandlers - Booking handler functions
	 */
	constructor(dbManager, bookingHandlers) {
		this.dbManager = dbManager;
		this.bookingHandlers = bookingHandlers;
		this.activeTasks = new Map(); // Map of taskKey -> scheduled job
	}

	/**
	 * Get all active task keys
	 * @returns {Array<string>} Array of task keys
	 */
	getActiveTaskKeys() {
		return Array.from(this.activeTasks.keys());
	}

	/**
	 * Check if a task exists
	 * @param {string} taskKey - The task key to check
	 * @returns {boolean} True if the task exists
	 */
	hasTask(taskKey) {
		return this.activeTasks.has(taskKey);
	}

	/**
	 * Add a scheduled task
	 * @param {string} taskKey - The task key
	 * @param {Object} scheduledJob - The scheduled job
	 */
	addScheduledTask(taskKey, scheduledJob) {
		this.activeTasks.set(taskKey, scheduledJob);
	}

	/**
	 * Recreate all schedules from database on startup
	 * @returns {Promise<Object>} Statistics about recreated schedules
	 */
	async recreateSchedulesFromDatabase() {
		try {
			const activeBookings = await this.dbManager.getActiveBookings();
			let recreatedCount = 0;

			for (const booking of activeBookings) {
				const success = await this.recreateSchedule(booking);
				if (success) {
					recreatedCount++;
				}
			}

			await this.dbManager.logToDatabase(
				'info',
				`Schedule recreation completed. ${recreatedCount}/${activeBookings.length} schedules recreated`,
				null,
				JSON.stringify({ total: activeBookings.length, recreated: recreatedCount })
			);

			return { total: activeBookings.length, recreated: recreatedCount };
		} catch (error) {
			await this.dbManager.logToDatabase(
				'error',
				'Failed to recreate schedules from database',
				null,
				JSON.stringify({ error: error.message })
			);
			throw error;
		}
	}

	/**
	 * Recreate a single schedule from booking data
	 * @param {Object} booking - The booking data
	 * @returns {Promise<boolean>} True if the schedule was recreated successfully
	 */
	async recreateSchedule(booking) {
		try {
			const taskKey = booking.task_key || booking.taskKey;
			const targetDate = new Date(booking.date);
			const currentDate = new Date();

			// Check if the booking date has already passed
			if (targetDate < currentDate) {
				await this.dbManager.updateBookingStatus(taskKey, 'expired');
				await this.dbManager.logToDatabase(
					'info',
					`Booking ${taskKey} marked as expired (target date has passed)`,
					taskKey
				);
				return false;
			}

			// Calculate booking release time (7 days before target date at 00:01 Dublin time)
			const bookingReleaseDate = new Date(targetDate);
			bookingReleaseDate.setDate(targetDate.getDate() - 7);

			// If the booking release time has already passed, try immediate booking
			if (bookingReleaseDate <= currentDate) {
				await this.dbManager.logToDatabase(
					'info',
					`Booking window already open for ${taskKey}, attempting immediate booking`,
					taskKey
				);

				// Try immediate booking
				this.handleImmediateBooking(booking);
				return true;
			}

			// Schedule the booking for the future
			const rule = new schedule.RecurrenceRule();
			rule.tz = 'Europe/Dublin';
			rule.year = bookingReleaseDate.getFullYear();
			rule.month = bookingReleaseDate.getMonth();
			rule.date = bookingReleaseDate.getDate();
			rule.hour = 0;
			rule.minute = 1;
			rule.second = 0;

			const task = schedule.scheduleJob(rule, async () => {
				await this.executeScheduledBooking(booking);
			});

			// Store the task
			this.activeTasks.set(taskKey, task);

			await this.dbManager.logToDatabase(
				'info',
				`Schedule recreated for ${taskKey}`,
				taskKey,
				JSON.stringify({
					scheduledFor: bookingReleaseDate.toISOString(),
					targetDate: booking.date,
				})
			);

			return true;
		} catch (error) {
			await this.dbManager.logToDatabase(
				'error',
				`Failed to recreate schedule for ${booking.task_key || booking.taskKey}`,
				booking.task_key || booking.taskKey,
				JSON.stringify({ error: error.message })
			);
			return false;
		}
	}

	/**
	 * Handle immediate booking (when booking window is already open)
	 * @param {Object} booking - The booking data
	 * @returns {Promise<Object>} Result of the booking attempt
	 */
	async handleImmediateBooking(booking) {
		const taskKey = booking.task_key || booking.taskKey;

		try {
			await this.dbManager.logToDatabase(
				'info',
				`Starting immediate booking process for ${taskKey}`,
				taskKey,
				JSON.stringify({
					date: booking.date,
					hour: booking.hour,
					court: booking.court,
				})
			);

			await this.dbManager.updateBookingStatus(taskKey, 'pending');

			// Make sure email_info is always defined
			const emailInfo =
				booking.email_info || booking.emailInfo || `Hall Tb ${booking.court} at ${booking.hour}:00`;

			const reservationDetails = {
				date: booking.date,
				hour: booking.hour,
				court: booking.court,
				emailInfo: emailInfo,
				name: booking.name,
				recurring: booking.recurring === true || booking.recurring === 'true',
			};

			// Add to active tasks during execution
			this.activeTasks.set(taskKey, { immediate: true });

			// Execute booking immediately
			const result = await this.bookingHandlers.handleBookingRequest(
				taskKey,
				booking.email,
				booking.password,
				booking.dir,
				reservationDetails
			);

			if (result && result.success) {
				await this.dbManager.updateBookingStatus(taskKey, 'completed', new Date().toISOString());
				await this.dbManager.logToDatabase('info', `Immediate booking successful for ${taskKey}`, taskKey);

				// If recurring, schedule next booking
				if (reservationDetails.recurring) {
					await this.scheduleNextRecurringBooking(booking);
				}
			} else {
				await this.dbManager.updateBookingStatus(taskKey, 'failed');
				await this.dbManager.logToDatabase(
					'warn',
					`Immediate booking failed for ${taskKey}`,
					taskKey,
					JSON.stringify({ result })
				);
			}

			// Remove from active tasks after completion
			this.activeTasks.delete(taskKey);

			return result;
		} catch (error) {
			await this.dbManager.updateBookingStatus(taskKey, 'failed');
			await this.dbManager.logToDatabase(
				'error',
				`Immediate booking failed for ${taskKey}`,
				taskKey,
				JSON.stringify({ error: error.message })
			);

			// Remove from active tasks in case of error
			this.activeTasks.delete(taskKey);

			throw error;
		}
	}

	/**
	 * Execute a scheduled booking
	 * @param {Object} booking - The booking data
	 * @returns {Promise<Object>} Result of the booking attempt
	 */
	async executeScheduledBooking(booking) {
		const taskKey = booking.task_key || booking.taskKey;

		try {
			await this.dbManager.updateBookingStatus(taskKey, 'pending');
			await this.dbManager.logToDatabase('info', `Executing scheduled booking ${taskKey}`, taskKey);

			// Make sure email_info is always defined
			const emailInfo =
				booking.email_info || booking.emailInfo || `Hall Tb ${booking.court} at ${booking.hour}:00`;

			const reservationDetails = {
				date: booking.date,
				hour: booking.hour,
				court: booking.court,
				emailInfo: emailInfo,
				name: booking.name,
				recurring: booking.recurring === true || booking.recurring === 'true',
			};

			// Execute the booking
			const result = await this.bookingHandlers.handleBookingRequest(
				taskKey,
				booking.email,
				booking.password,
				booking.dir,
				reservationDetails
			);

			if (result && result.success) {
				await this.dbManager.updateBookingStatus(taskKey, 'completed', new Date().toISOString());
				await this.dbManager.logToDatabase('info', `Scheduled booking successful for ${taskKey}`, taskKey);

				// If recurring, schedule next booking
				if (reservationDetails.recurring) {
					await this.scheduleNextRecurringBooking(booking);
				}
			} else {
				await this.dbManager.updateBookingStatus(taskKey, 'failed');
				await this.dbManager.logToDatabase(
					'warn',
					`Scheduled booking failed for ${taskKey}`,
					taskKey,
					JSON.stringify({ result })
				);
			}

			// Remove from active tasks
			this.activeTasks.delete(taskKey);

			return result;
		} catch (error) {
			await this.dbManager.updateBookingStatus(taskKey, 'failed');
			await this.dbManager.logToDatabase(
				'error',
				`Scheduled booking execution failed for ${taskKey}`,
				taskKey,
				JSON.stringify({ error: error.message })
			);

			// Remove from active tasks in case of error
			this.activeTasks.delete(taskKey);

			throw error;
		}
	}

	/**
	 * Schedule next recurring booking
	 * @param {Object} originalBooking - The original booking data
	 * @returns {Promise<void>}
	 */
	async scheduleNextRecurringBooking(originalBooking) {
		try {
			const nextWeek = new Date(originalBooking.date);
			nextWeek.setDate(nextWeek.getDate() + 7);

			const nextTaskKey = `${originalBooking.name}_${originalBooking.hour}_${
				originalBooking.court
			}_${Date.now()}`;

			// Make sure email_info is always defined
			const emailInfo =
				originalBooking.email_info ||
				originalBooking.emailInfo ||
				`Hall Tb ${originalBooking.court} at ${originalBooking.hour}:00`;

			const nextBookingData = {
				taskKey: nextTaskKey,
				name: originalBooking.name,
				email: originalBooking.email,
				password: originalBooking.password,
				dir: originalBooking.dir,
				date: nextWeek.toISOString().split('T')[0],
				hour: originalBooking.hour,
				court: originalBooking.court,
				emailInfo: emailInfo,
				recurring: true,
				status: 'scheduled',
				scheduledRunTime: this.calculateScheduledRunTime(nextWeek).toISOString(),
			};

			// Save next booking to database
			await this.dbManager.saveBooking(nextBookingData);

			// Create the schedule for next booking
			await this.recreateSchedule(nextBookingData);

			await this.dbManager.logToDatabase(
				'info',
				`Next recurring booking scheduled for ${nextBookingData.date}`,
				nextTaskKey,
				JSON.stringify({ originalTaskKey: originalBooking.task_key })
			);
		} catch (error) {
			await this.dbManager.logToDatabase(
				'error',
				`Failed to schedule next recurring booking for ${originalBooking.task_key}`,
				originalBooking.task_key,
				JSON.stringify({ error: error.message })
			);
		}
	}

	/**
	 * Cancel a scheduled task
	 * @param {string} taskKey - The task key to cancel
	 * @returns {Promise<boolean>} True if the task was cancelled
	 */
	async cancelScheduledTask(taskKey) {
		const task = this.activeTasks.get(taskKey);
		if (task) {
			if (task.cancel) {
				task.cancel();
			}
			this.activeTasks.delete(taskKey);

			// Update database status
			try {
				await this.dbManager.updateBookingStatus(taskKey, 'cancelled');
				await this.dbManager.logToDatabase(
					'info',
					`Task ${taskKey} cancelled and marked as cancelled in database`,
					taskKey
				);
				return true;
			} catch (dbError) {
				await this.dbManager.logToDatabase(
					'warn',
					`Task ${taskKey} cancelled but failed to update database: ${dbError.message}`,
					taskKey
				);
				return true;
			}
		}

		// If not in active tasks, check database
		try {
			const bookingInDb = await this.dbManager.getBookingByTaskKey(taskKey);
			if (bookingInDb) {
				await this.dbManager.updateBookingStatus(taskKey, 'cancelled');
				await this.dbManager.logToDatabase(
					'warn',
					`Task ${taskKey} found in database but not active. Marked as cancelled.`,
					taskKey
				);
				return true;
			}
		} catch (error) {
			await this.dbManager.logToDatabase(
				'error',
				`Error checking database for task ${taskKey}: ${error.message}`,
				taskKey
			);
		}

		return false;
	}

	/**
	 * Create a new booking
	 * @param {Object} bookingData - The booking data
	 * @returns {Promise<Object>} The result with taskKey and success status
	 */
	async createBooking(bookingData) {
		try {
			// Generate task key if not provided
			if (!bookingData.taskKey) {
				bookingData.taskKey = `${bookingData.name}_${bookingData.hour}_${bookingData.court}_${Date.now()}`;
			}

			const taskKey = bookingData.taskKey;

			// Make sure email_info is always defined
			if (!bookingData.emailInfo) {
				bookingData.emailInfo = `Hall Tb ${bookingData.court} at ${bookingData.hour}:00`;
			}

			// Calculate scheduled run time
			const targetDate = new Date(bookingData.date);
			bookingData.scheduledRunTime = this.calculateScheduledRunTime(targetDate).toISOString();

			// Save to database
			await this.dbManager.saveBooking(bookingData);

			// Create schedule
			const success = await this.recreateSchedule(bookingData);

			if (success) {
				await this.dbManager.logToDatabase(
					'info',
					`New booking created: ${taskKey}`,
					taskKey,
					JSON.stringify({
						date: bookingData.date,
						hour: bookingData.hour,
						court: bookingData.court,
					})
				);
			}

			return { taskKey, success };
		} catch (error) {
			await this.dbManager.logToDatabase(
				'error',
				`Failed to create booking: ${error.message}`,
				null,
				JSON.stringify({ error: error.message })
			);
			throw error;
		}
	}

	/**
	 * Calculate scheduled run time (7 days before target date)
	 * @param {Date} targetDate - The target date
	 * @returns {Date} The calculated run time
	 */
	calculateScheduledRunTime(targetDate) {
		const bookingReleaseDate = new Date(targetDate);
		bookingReleaseDate.setDate(targetDate.getDate() - 7);

		// Set time to 00:01:00 Dublin time
		bookingReleaseDate.setHours(0, 1, 0, 0);

		return bookingReleaseDate;
	}

	/**
	 * Cleanup expired schedules
	 * @returns {Promise<number>} Number of expired bookings cleaned up
	 */
	async cleanupExpiredSchedules() {
		try {
			const now = new Date();
			const expiredBookings = [];

			// Find expired bookings in active tasks
			for (const [taskKey, task] of this.activeTasks.entries()) {
				try {
					const booking = await this.dbManager.getBookingByTaskKey(taskKey);
					if (booking && new Date(booking.date) < now) {
						expiredBookings.push(taskKey);
					}
				} catch (error) {
					await this.dbManager.logToDatabase(
						'error',
						`Error checking if task ${taskKey} is expired: ${error.message}`,
						taskKey
					);
				}
			}

			// Cancel and mark expired bookings
			for (const taskKey of expiredBookings) {
				const task = this.activeTasks.get(taskKey);
				if (task && task.cancel) {
					task.cancel();
				}
				this.activeTasks.delete(taskKey);
				await this.dbManager.updateBookingStatus(taskKey, 'expired');
			}

			// Also mark any database bookings that have passed their date
			await this.dbManager.markExpiredBookings();

			if (expiredBookings.length > 0) {
				await this.dbManager.logToDatabase(
					'info',
					`Cleaned up ${expiredBookings.length} expired schedules`,
					null,
					JSON.stringify({ expiredBookings })
				);
			}

			return expiredBookings.length;
		} catch (error) {
			await this.dbManager.logToDatabase(
				'error',
				`Failed to cleanup expired schedules: ${error.message}`,
				null,
				JSON.stringify({ error: error.message })
			);
			throw error;
		}
	}

	/**
	 * Get all active bookings
	 * @returns {Promise<Object>} Object with count and bookings array
	 */
	async getActiveBookings() {
		try {
			const activeBookings = await this.dbManager.getActiveBookings();
			return {
				count: activeBookings.length,
				bookings: activeBookings,
			};
		} catch (error) {
			await this.dbManager.logToDatabase(
				'error',
				`Failed to get active bookings: ${error.message}`,
				null,
				JSON.stringify({ error: error.message })
			);
			throw error;
		}
	}

	/**
	 * Get details of a specific booking
	 * @param {string} taskKey - The task key to get details for
	 * @returns {Promise<Object|null>} The booking details or null if not found
	 */
	async getBookingDetails(taskKey) {
		try {
			const booking = await this.dbManager.getBookingByTaskKey(taskKey);
			const isActive = this.activeTasks.has(taskKey);

			if (booking) {
				return {
					...booking,
					isActive,
					inMemory: isActive,
				};
			}

			return null;
		} catch (error) {
			await this.dbManager.logToDatabase(
				'error',
				`Failed to get booking details for ${taskKey}: ${error.message}`,
				taskKey,
				JSON.stringify({ error: error.message })
			);
			throw error;
		}
	}

	/**
	 * Get the number of active tasks
	 * @returns {number} The number of active tasks
	 */
	getTaskCount() {
		return this.activeTasks.size;
	}
}

module.exports = ScheduleManager;
