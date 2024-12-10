# leinster_ttc_booking

Booking automation app for LCC table tennis. No more missing out on booking a slot - automated and optionally recurring.

### Instructions

-   Make directory "certs" at root of the projects
-   Generate cert with `openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes`
-   Fill in `.envsample` and rename to `.env`
-   Run with `docker-compose up --build -d` to build an image and run in detached mode
    -   Alternatively, run w/o docker with `npm run start`
    -   Minimum tested version is `Node 18 LTS`, but it _might_ work with older versions too
