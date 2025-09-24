# Leinster TTC Booking


# This repository is now archived and will not receive any further updates. The club is moving away from using this booking system.       

Booking automation app for LCC table tennis. No more missing out on booking a slot - automated and optionally recurring with full persistence and database logging.

## Features

-   **Automated Booking**: Books table tennis slots automatically when they become available (7 days in advance)
-   **Recurring Bookings**: Set up weekly recurring bookings that continue indefinitely
-   **Immediate Booking**: If a slot is within 7 days, attempts immediate booking
-   **SQLite Persistence**: All bookings, logs, and schedules are stored in a SQLite database
-   **Schedule Recovery**: Automatically recreates schedules from database on server restart
-   **Comprehensive Logging**: All activities are logged to both console and database
-   **Clean REST API**: Minimal, well-documented REST API for managing bookings and viewing statistics
-   **Docker Support**: Easy deployment with Docker and Docker Compose

## Quick Start

### Prerequisites

-   Node.js 18+ LTS (if running without Docker)
-   Docker and Docker Compose (for containerized deployment)

### Setup Instructions

1. **Create SSL certificates directory:**

    ```bash
    mkdir certs
    ```

2. **Generate SSL certificates:**

    ```bash
    openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes
    ```

3. **Configure environment variables:**

    - Copy `.envsample` to `.env`
    - Fill in your booking credentials and settings

4. **Run with Docker (Recommended):**

    ```bash
    docker-compose up --build -d
    ```

    **Or run without Docker:**

    ```bash
    npm install
    npm start
    ```

5. **Access the application:**
    - HTTPS: `https://localhost:3037` (if SSL certs are available)
    - HTTP: `http://localhost:3037` (fallback)

## Database Features

### Automatic Persistence

-   All booking requests are saved to SQLite database
-   Logs are stored with different levels (info, warn, error, debug)
-   Booking attempts and results are tracked
-   Schedule information is preserved for recovery

### Schedule Recovery

-   On server restart, all active schedules are automatically recreated from database
-   Handles timezone calculations correctly for Dublin timezone
-   Expired bookings are automatically marked as such

### Database Management

Use the migration script for database maintenance:

```bash
# Initialize database
node migrate.js init

# Create backup
node migrate.js backup

# Clean up old logs and expired bookings
node migrate.js cleanup

# View database statistics
node migrate.js stats
```

## API Endpoints

### New API Structure

The application now provides a clean REST API with the following endpoints:

#### Booking Management

-   `POST /api/bookings` - Create a new booking (immediate or scheduled)
-   `DELETE /api/bookings/:taskKey` - Cancel a scheduled booking
-   `GET /api/bookings` - Get booking history with optional filtering

#### Task Management

-   `GET /api/tasks` - Get active scheduled tasks
-   `GET /api/tasks/stats` - Get system statistics

#### Legacy Compatibility

For backwards compatibility, the following legacy endpoints are still supported:

-   `POST /start` - Redirects to `POST /api/bookings`
-   `POST /stop` - Redirects to `DELETE /api/bookings/:taskKey`
-   `GET /tasks` - Redirects to `GET /api/tasks`
-   `GET /stats` - Redirects to `GET /api/tasks/stats`
-   `GET /bookings` - Redirects to `GET /api/bookings`

### Example API Usage

**Create a booking:**

```bash
curl -X POST https://localhost:3037/api/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2025-07-15",
    "hour": "19",
    "court": "1",
    "emailInfo": "your-email@example.com",
    "name": "Your Name",
    "recurring": "true"
  }'
```

**Cancel a booking:**

```bash
curl -X DELETE https://localhost:3037/api/bookings/Your_Name_19_1_1688394750123
```

**Get statistics:**

```bash
curl https://localhost:3037/api/tasks/stats
```

**Get booking history:**

```bash
curl https://localhost:3037/api/bookings?status=completed&limit=10
```

## Data Storage

### Directory Structure

```
data/
├── booking_data.db     # SQLite database
backups/               # Database backups (created by migrate.js)
├── booking_data_backup_*.db
```

### Database Schema

-   **bookings**: Stores all booking information and status
-   **logs**: Application logs with different severity levels
-   **booking_attempts**: Tracks individual booking attempts for debugging

## Configuration

### Environment Variables

-   `EMAIL`: Your booking system email
-   `PASSWORD`: Your booking system password
-   `DIR`: Directory parameter for booking system
-   `PORT`: Server port (default: 3000)

### Docker Configuration

The application includes proper Docker volumes for:

-   SSL certificates (`./certs:/app/certs`)
-   Database persistence (`./data:/app/data`)
-   Application code (`./app:/app`)

## Monitoring & Troubleshooting

### Logs

-   View real-time logs: `GET /logs`
-   Logs include timestamp, level, message, and optional task context
-   Database stores detailed error information and stack traces

### Statistics

-   Monitor booking success/failure rates
-   Track active vs completed bookings
-   Database size and performance metrics

### Health Checks

-   Application automatically recreates schedules on restart
-   Failed bookings are retried automatically
-   Expired schedules are cleaned up periodically

## Development

### Requirements

-   Node.js 18+ LTS
-   npm or yarn

### Development Mode

```bash
npm install
npm run dev  # Uses nodemon for auto-restart
```

### Code Structure

The application follows clean code principles with a well-organized folder structure:

```
src/
├── index.js              # Main application entry point
├── lib/                  # Core business logic modules
│   ├── database.js       # Database management and persistence
│   └── scheduleManager.js # Task scheduling and execution
└── routes/               # API route definitions
    ├── index.js          # Routes module exports
    ├── bookings.js       # Booking-related endpoints
    └── tasks.js          # Task and statistics endpoints

config/
└── index.js              # Application configuration and validation

scripts/
└── migrate.js            # Database migration and maintenance utilities

public/                   # Static web assets
data/                     # Database storage
certs/                    # SSL certificates
```

All modules include comprehensive JSDoc comments and follow modern JavaScript best practices.

## License

MIT
