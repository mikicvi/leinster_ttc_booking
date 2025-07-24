/**
 * @fileoverview Application configuration
 * Centralizes all application configuration and environment variables
 *
 * @module config/index
 * @author Leinster TTC Booking Team
 * @license MIT
 */

require('dotenv').config();

/**
 * Application configuration object
 * @type {Object}
 */
const config = {
	/**
	 * Server configuration
	 */
	server: {
		port: process.env.PORT || 3037,
		host: process.env.HOST || 'localhost',
	},

	/**
	 * Booking service credentials
	 */
	booking: {
		email: process.env.EMAIL,
		password: process.env.PASSWORD,
		dir: process.env.DIR,
	},

	/**
	 * Database configuration
	 */
	database: {
		path: process.env.DATABASE_PATH || './data/booking_data.db',
		logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS) || 30,
	},

	/**
	 * SSL/TLS configuration
	 */
	ssl: {
		keyPath: './certs/key.pem',
		certPath: './certs/cert.pem',
	},

	/**
	 * Application settings
	 */
	app: {
		bookingAdvanceDays: 7, // How many days in advance bookings become available
		retryAttempts: 3, // Number of retry attempts for failed bookings
		retryDelay: 5000, // Delay between retry attempts in milliseconds
		cleanupInterval: 24 * 60 * 60 * 1000, // Cleanup interval in milliseconds (24 hours)
	},
};

/**
 * Validates that all required configuration is present
 * @returns {Object} Validation result
 */
function validateConfig() {
	const required = ['booking.email', 'booking.password', 'booking.dir'];

	const missing = [];

	for (const key of required) {
		const value = key.split('.').reduce((obj, k) => obj?.[k], config);
		if (!value) {
			missing.push(key);
		}
	}

	return {
		valid: missing.length === 0,
		missing,
	};
}

module.exports = {
	config,
	validateConfig,
};
