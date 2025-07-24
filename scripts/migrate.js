#!/usr/bin/env node

/**
 * Database Migration Script
 *
 * This script helps with database migrations and maintenance tasks.
 * Usage: node migrate.js [command]
 *
 * Commands:
 *   init     - Initialize the database with current schema
 *   backup   - Create a backup of the current database
 *   restore  - Restore from a backup file
 *   cleanup  - Clean up old logs and expired bookings
 *   stats    - Show database statistics
 */

const DatabaseManager = require('../src/lib/database');
const fs = require('fs');
const path = require('path');

class MigrationManager {
	constructor() {
		this.dbManager = new DatabaseManager();
	}

	async init() {
		console.log('Initializing database...');
		await this.dbManager.initialize();
		console.log('Database initialized successfully.');
	}

	async backup() {
		const backupDir = path.join(__dirname, 'backups');
		if (!fs.existsSync(backupDir)) {
			fs.mkdirSync(backupDir, { recursive: true });
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backupPath = path.join(backupDir, `booking_data_backup_${timestamp}.db`);

		console.log('Creating database backup...');

		// Simple file copy for SQLite
		if (fs.existsSync(this.dbManager.dbPath)) {
			fs.copyFileSync(this.dbManager.dbPath, backupPath);
			console.log(`Backup created: ${backupPath}`);
		} else {
			console.log('No database file found to backup.');
		}
	}

	async cleanup() {
		console.log('Starting database cleanup...');
		await this.dbManager.initialize();

		// Clean up old logs
		await this.dbManager.cleanupLogs();
		console.log('Old logs cleaned up.');

		// Mark expired bookings
		const expiredBookings = await this.dbManager.getAllQuery(`
			UPDATE bookings 
			SET status = 'expired', updated_at = CURRENT_TIMESTAMP
			WHERE status IN ('scheduled', 'pending') 
			AND date < date('now')
		`);

		console.log(`Marked expired bookings.`);

		// Get cleanup stats
		const stats = await this.dbManager.getStats();
		console.log('Cleanup completed. Current stats:', stats);
	}

	async stats() {
		console.log('Fetching database statistics...');
		await this.dbManager.initialize();

		const stats = await this.dbManager.getStats();

		console.log('\n=== Database Statistics ===');
		console.log(`Total Bookings: ${stats.totalBookings}`);
		console.log(`Active Bookings: ${stats.activeBookings}`);
		console.log(`Completed Bookings: ${stats.completedBookings}`);
		console.log(`Failed Bookings: ${stats.failedBookings}`);
		console.log(`Total Logs: ${stats.totalLogs}`);

		// Recent bookings by status
		const recentBookings = await this.dbManager.getAllQuery(`
			SELECT status, COUNT(*) as count 
			FROM bookings 
			WHERE created_at > datetime('now', '-7 days')
			GROUP BY status
		`);

		console.log('\n=== Recent Bookings (Last 7 Days) ===');
		recentBookings.forEach((row) => {
			console.log(`${row.status}: ${row.count}`);
		});

		// Database size
		const dbStats = fs.statSync(this.dbManager.dbPath);
		console.log(`\nDatabase File Size: ${(dbStats.size / 1024 / 1024).toFixed(2)} MB`);
	}

	async close() {
		if (this.dbManager) {
			this.dbManager.close();
		}
	}
}

// Main execution
async function main() {
	const command = process.argv[2] || 'help';
	const migrationManager = new MigrationManager();

	try {
		switch (command) {
			case 'init':
				await migrationManager.init();
				break;
			case 'backup':
				await migrationManager.backup();
				break;
			case 'cleanup':
				await migrationManager.cleanup();
				break;
			case 'stats':
				await migrationManager.stats();
				break;
			case 'help':
			default:
				console.log(`
Database Migration Script

Usage: node migrate.js [command]

Commands:
  init     - Initialize the database with current schema
  backup   - Create a backup of the current database
  cleanup  - Clean up old logs and expired bookings
  stats    - Show database statistics
  help     - Show this help message
				`);
				break;
		}
	} catch (error) {
		console.error('Migration failed:', error.message);
		process.exit(1);
	} finally {
		await migrationManager.close();
	}
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
	console.log('\nShutting down...');
	process.exit(0);
});

if (require.main === module) {
	main();
}

module.exports = MigrationManager;
