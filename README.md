# CampusFix

CampusFix is a React + Express prototype with two dashboard roles: students see their own complaints; administrators see campus-wide complaints and student details.

## Presentation features

- Separate student and admin sign-in entry screens; account role is checked by the API.
- Student complaint cards open a detail view with a status timeline.
- Admin analytics include status, category, and seven-day activity charts.
- The illustrative campus map has clickable complaint markers.
- **Preview demo data** shows fictional records and sample trends without saving them to the database. It is clearly labeled and can be turned off to return to live records.
- Complaint status changes are recorded in the SQLite event history. Admins can permanently delete a complaint with an in-app confirmation; its uploaded photo and status history are removed too.

## Run locally

Requirements: Node.js 20.19+ or 22.12+.

1. Copy `.env.example` to `.env` and set a long random `JWT_SECRET`, plus a private admin email/password.
2. Run `npm install`.
3. Start the backend with `npm run api`.
4. In a second terminal, run `npm run dev` and open the local Vite URL.

Vite forwards `/api` calls to `http://localhost:3000`. The API creates `server/campusfix.sqlite` and saves photo uploads in `uploads/`. Admin credentials come from `.env`; students register from the student portal. Public registration always creates a student account.

## Prototype boundaries

The campus map uses illustrative building zones because no real campus map/coordinates were supplied. Category and priority suggestions use editable keyword rules, not an AI vision model. Demo records and demo trend figures are fictional, presentation-only content. For campus deployment, use actual campus coordinates, institutional authentication, hosted database/image storage, HTTPS, backups, and an approved AI service.

