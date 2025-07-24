/**
 * @fileoverview Routes index file
 * Exports all route modules for easy importing
 *
 * @module routes/index
 * @author Leinster TTC Booking Team
 * @license MIT
 */

const setupBookingRoutes = require('./bookings');
const setupTaskRoutes = require('./tasks');

module.exports = {
	setupBookingRoutes,
	setupTaskRoutes,
};
