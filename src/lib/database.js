/**
 * @fileoverview Database Manager for Leinster TTC Booking Application
 * Handles all database operations, including booking persistence, logs and statistics.
 * @module database
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

/**
 * Manages all database operations for the booking system
 */
class DatabaseManager {
	/**
	 * Creates a new DatabaseManager instance and sets up the database path
	 */
	constructor() {
		this.db = null;
		// Ensure data directory exists and store database there
		const dataDir = path.join(__dirname, 'data');
		if (!fs.existsSync(dataDir)) {
			fs.mkdirSync(dataDir, { recursive: true });
		}
		this.dbPath = path.join(dataDir, 'booking_data.db');
	}

	/**
	 * Initialize database connection and create tables if they don't exist
	 * @returns {Promise<void>} A promise that resolves when database is initialized
	 */
	async initialize() {
		return new Promise((resolve, reject) => {
			this.db = new sqlite3.Database(this.dbPath, (err) => {
				if (err) {
					console.error('Error opening database:', err.message);
					reject(err);
				} else {
					console.log('Connected to SQLite database.');
					this.createTables()
						.then(() => resolve())
						.catch(reject);
				}
			});
		});
	}

	/**
	 * Create necessary database tables if they don't exist
	 * @returns {Promise<void>} A promise that resolves when tables are created
	 */
	async createTables() {
		const tables = [
			// Table for storing booking information
			`CREATE TABLE IF NOT EXISTS bookings (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				task_key TEXT UNIQUE NOT NULL,
				name TEXT NOT NULL,
				email TEXT NOT NULL,
				password TEXT NOT NULL,
				dir TEXT NOT NULL,
				date TEXT NOT NULL,
				hour INTEGER NOT NULL,
				court INTEGER NOT NULL,
				email_info TEXT NOT NULL,
				recurring BOOLEAN DEFAULT 0,
				status TEXT DEFAULT 'scheduled',
				scheduled_run_time TEXT,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				completed_at DATETIME NULL
			)`,

			// Table for storing application logs
			`CREATE TABLE IF NOT EXISTS logs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				level TEXT DEFAULT 'info',
				message TEXT NOT NULL,
				task_key TEXT NULL,
				timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
				details TEXT NULL
			)`,

			// Table for storing booking attempts and results
			`CREATE TABLE IF NOT EXISTS booking_attempts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				booking_id INTEGER NOT NULL,
				attempt_number INTEGER NOT NULL,
				status TEXT NOT NULL,
				error_message TEXT NULL,
				attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (booking_id) REFERENCES bookings (id)
			)`,
		];

		for (const tableSQL of tables) {
			await this.runQuery(tableSQL);
		}

		// Create indexes for better performance
		const indexes = [
			'CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)',
			'CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date)',
			'CREATE INDEX IF NOT EXISTS idx_bookings_task_key ON bookings(task_key)',
			'CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)',
			'CREATE INDEX IF NOT EXISTS idx_logs_task_key ON logs(task_key)',
		];

		for (const indexSQL of indexes) {
			await this.runQuery(indexSQL);
		}
	}

	/**
	 * Run a SQL query that modifies data (INSERT, UPDATE, DELETE)
	 * @param {string} sql - The SQL query to run
	 * @param {Array} params - Array of parameters for the query
	 * @returns {Promise<Object>} A promise that resolves with the query result
	 */
	runQuery(sql, params = []) {
		return new Promise((resolve, reject) => {
			this.db.run(sql, params, function (err) {
				if (err) {
					reject(err);
				} else {
					resolve({ id: this.lastID, changes: this.changes });
				}
			});
		});
	}

	/**
	 * Get a single row from the database
	 * @param {string} sql - The SQL query to run
	 * @param {Array} params - Array of parameters for the query
	 * @returns {Promise<Object|null>} A promise that resolves with the row or null
	 */
	getQuery(sql, params = []) {
		return new Promise((resolve, reject) => {
			this.db.get(sql, params, (err, row) => {
				if (err) {
					reject(err);
				} else {
					resolve(row);
				}
			});
		});
	}

	/**
	 * Get multiple rows from the database
	 * @param {string} sql - The SQL query to run
	 * @param {Array} params - Array of parameters for the query
	 * @returns {Promise<Array>} A promise that resolves with an array of rows
	 */
	getAllQuery(sql, params = []) {
		return new Promise((resolve, reject) => {
			this.db.all(sql, params, (err, rows) => {
				if (err) {
					reject(err);
				} else {
					resolve(rows);
				}
			});
		});
	}

	/**
	 * Save booking to database or update if it already exists
	 * @param {Object} bookingData - The booking data to save
	 * @param {string} bookingData.taskKey - Unique identifier for the booking
	 * @param {string} bookingData.name - Name of the person making the booking
	 * @param {string} bookingData.email - Email for login
	 * @param {string} bookingData.password - Password for login
	 * @param {string} bookingData.dir - Directory parameter for the booking site
	 * @param {string} bookingData.date - Date of the booking (YYYY-MM-DD)
	 * @param {number} bookingData.hour - Hour of the booking
	 * @param {number} bookingData.court - Court number
	 * @param {string} bookingData.emailInfo - Email information for the booking
	 * @param {boolean} [bookingData.recurring=false] - Whether the booking is recurring
	 * @param {string} [bookingData.status='scheduled'] - Status of the booking
	 * @param {string} [bookingData.scheduledRunTime=null] - When the booking is scheduled to run
	 * @returns {Promise<Object>} A promise that resolves with the query result
	 */
	async saveBooking(bookingData) {
		const {
			taskKey,
			name,
			email,
			password,
			dir,
			date,
			hour,
			court,
			emailInfo,
			recurring = false,
			status = 'scheduled',
			scheduledRunTime = null,
		} = bookingData;

		try {
			// Check if booking already exists
			const existingBooking = await this.getBookingByTaskKey(taskKey);

			if (existingBooking) {
				// Update existing booking
				const updateSql = `
					UPDATE bookings
					SET name = ?, email = ?, password = ?, dir = ?, date = ?, 
					    hour = ?, court = ?, email_info = ?, recurring = ?, 
					    status = ?, scheduled_run_time = ?, updated_at = CURRENT_TIMESTAMP
					WHERE task_key = ?
				`;

				const updateParams = [
					name,
					email,
					password,
					dir,
					date,
					hour,
					court,
					emailInfo,
					recurring ? 1 : 0,
					status,
					scheduledRunTime,
					taskKey,
				];

				return await this.runQuery(updateSql, updateParams);
			} else {
				// Insert new booking
				const insertSql = `
					INSERT INTO bookings 
					(task_key, name, email, password, dir, date, hour, court, email_info, recurring, status, scheduled_run_time)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`;

				const insertParams = [
					taskKey,
					name,
					email,
					password,
					dir,
					date,
					hour,
					court,
					emailInfo,
					recurring ? 1 : 0,
					status,
					scheduledRunTime,
				];

				return await this.runQuery(insertSql, insertParams);
			}
		} catch (error) {
			console.error(`Failed to save booking to database: ${error.message}`);
			throw new Error(`Failed to save booking to database: ${error.message}`);
		}
	}

	/**
	 * Update the status of a booking
	 * @param {string} taskKey - The unique identifier of the booking
	 * @param {string} status - The new status
	 * @param {string|null} completedAt - ISO timestamp when the booking was completed
	 * @returns {Promise<Object>} A promise that resolves with the query result
	 */
	async updateBookingStatus(taskKey, status, completedAt = null) {
		try {
			// First, check if the booking exists to avoid NULL constraint errors
			const booking = await this.getBookingByTaskKey(taskKey);
			if (!booking) {
				throw new Error(`Booking with key ${taskKey} not found`);
			}

			const sql = `
				UPDATE bookings 
				SET status = ?, updated_at = CURRENT_TIMESTAMP, completed_at = ?
				WHERE task_key = ?
			`;
			return await this.runQuery(sql, [status, completedAt, taskKey]);
		} catch (error) {
			console.error(`Failed to update booking status: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get a booking by its task key
	 * @param {string} taskKey - The unique identifier of the booking
	 * @returns {Promise<Object|null>} A promise that resolves with the booking or null
	 */
	async getBookingByTaskKey(taskKey) {
		const sql = 'SELECT * FROM bookings WHERE task_key = ?';
		return await this.getQuery(sql, [taskKey]);
	}

	/**
	 * Get all active bookings (for recreation on restart)
	 * @returns {Promise<Array>} A promise that resolves with an array of active bookings
	 */
	async getActiveBookings() {
		const sql = `
			SELECT * FROM bookings 
			WHERE status IN ('scheduled', 'pending') 
			ORDER BY scheduled_run_time ASC
		`;
		return await this.getAllQuery(sql);
	}

	/**
	 * Remove a booking from the database
	 * @param {string} taskKey - The unique identifier of the booking
	 * @returns {Promise<Object>} A promise that resolves with the query result
	 */
	async removeBooking(taskKey) {
		const sql = 'DELETE FROM bookings WHERE task_key = ?';
		return await this.runQuery(sql, [taskKey]);
	}

	/**
	 * Log a message to the database
	 * @param {string} level - Log level (info, warn, error, debug)
	 * @param {string} message - The message to log
	 * @param {string|null} taskKey - Associated task key, if any
	 * @param {string|null} details - Additional details (typically JSON string)
	 * @returns {Promise<Object>} A promise that resolves with the query result
	 */
	async logToDatabase(level, message, taskKey = null, details = null) {
		const sql = `
			INSERT INTO logs (level, message, task_key, details)
			VALUES (?, ?, ?, ?)
		`;
		return await this.runQuery(sql, [level, message, taskKey, details]);
	}

	/**
	 * Get recent logs from the database
	 * @param {number} [limit=100] - Maximum number of logs to retrieve
	 * @returns {Promise<Array>} A promise that resolves with an array of logs
	 */
	async getRecentLogs(limit = 100) {
		const sql = `
			SELECT * FROM logs 
			ORDER BY timestamp DESC 
			LIMIT ?
		`;
		return await this.getAllQuery(sql, [limit]);
	}

	/**
	 * Get recent logs for a specific task
	 * @param {string} taskKey - The unique identifier of the task
	 * @param {number} [limit=20] - Maximum number of logs to retrieve
	 * @returns {Promise<Array>} A promise that resolves with an array of logs
	 */
	async getRecentTaskLogs(taskKey, limit = 20) {
		const sql = `
			SELECT * FROM logs 
			WHERE task_key = ? 
			ORDER BY timestamp DESC
			LIMIT ?
		`;
		return await this.getAllQuery(sql, [taskKey, limit]);
	}

	/**
	 * Get paginated logs from the database
	 * @param {number} [limit=15] - Maximum number of logs to retrieve per page
	 * @param {number} [offset=0] - Number of logs to skip
	 * @returns {Promise<Array>} A promise that resolves with an array of logs
	 */
	async getPaginatedLogs(limit = 15, offset = 0) {
		const sql = `
			SELECT * FROM logs 
			ORDER BY timestamp DESC 
			LIMIT ? OFFSET ?
		`;
		return await this.getAllQuery(sql, [limit, offset]);
	}

	/**
	 * Get total count of logs in the database
	 * @returns {Promise<number>} A promise that resolves with the total count of logs
	 */
	async getLogsCount() {
		const sql = `SELECT COUNT(*) as count FROM logs`;
		const result = await this.getQuery(sql);
		return result.count;
	}

	/**
	 * Save a booking attempt to the database
	 * @param {number} bookingId - The ID of the booking
	 * @param {number} attemptNumber - The attempt number
	 * @param {string} status - The status of the attempt
	 * @param {string|null} errorMessage - Error message, if any
	 * @returns {Promise<Object>} A promise that resolves with the query result
	 */
	async saveBookingAttempt(bookingId, attemptNumber, status, errorMessage = null) {
		const sql = `
			INSERT INTO booking_attempts (booking_id, attempt_number, status, error_message)
			VALUES (?, ?, ?, ?)
		`;
		return await this.runQuery(sql, [bookingId, attemptNumber, status, errorMessage]);
	}

	/**
	 * Get all booking attempts for a booking
	 * @param {number} bookingId - The ID of the booking
	 * @returns {Promise<Array>} A promise that resolves with an array of booking attempts
	 */
	async getBookingAttempts(bookingId) {
		const sql = `
			SELECT * FROM booking_attempts 
			WHERE booking_id = ? 
			ORDER BY attempted_at DESC
		`;
		return await this.getAllQuery(sql, [bookingId]);
	}

	/**
	 * Close the database connection
	 */
	close() {
		if (this.db) {
			this.db.close((err) => {
				if (err) {
					console.error('Error closing database:', err.message);
				} else {
					console.log('Database connection closed.');
				}
			});
		}
	}

	/**
	 * Clean up old logs (keep only last 1000 entries)
	 * @returns {Promise<Object>} A promise that resolves with the query result
	 */
	async cleanupLogs() {
		const sql = `
			DELETE FROM logs 
			WHERE id NOT IN (
				SELECT id FROM logs 
				ORDER BY timestamp DESC 
				LIMIT 1000
			)
		`;
		return await this.runQuery(sql);
	}

	/**
	 * Get database statistics
	 * @returns {Promise<Object>} A promise that resolves with database statistics
	 */
	async getStats() {
		const queries = {
			totalBookings: 'SELECT COUNT(*) as count FROM bookings',
			activeBookings: 'SELECT COUNT(*) as count FROM bookings WHERE status IN ("scheduled", "pending")',
			completedBookings: 'SELECT COUNT(*) as count FROM bookings WHERE status = "completed"',
			failedBookings: 'SELECT COUNT(*) as count FROM bookings WHERE status = "failed"',
			totalLogs: 'SELECT COUNT(*) as count FROM logs',
		};

		const stats = {};
		for (const [key, sql] of Object.entries(queries)) {
			const result = await this.getQuery(sql);
			stats[key] = result.count;
		}

		return stats;
	}

	/**
	 * Mark bookings as expired if their date has passed
	 * @returns {Promise<number>} Number of bookings marked as expired
	 */
	async markExpiredBookings() {
		const sql = `
			UPDATE bookings 
			SET status = 'expired' 
			WHERE status IN ('scheduled', 'pending') 
			AND date < date('now')
		`;

		const result = await this.runQuery(sql);
		return result.changes; // Return number of rows affected
	}
}

module.exports = DatabaseManager;
