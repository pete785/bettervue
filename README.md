# BetterVUE

A modern, fast replacement for the StudentVUE web portal. BetterVUE talks directly to your district's EduPoint/Synergy backend and presents grades, assignments, and attendance in a clean PowerSchool-style interface.

## Quick start

```bash
node server.js
```

Open [http://localhost:3847](http://localhost:3847) and sign in with:

- **District URL** — your district's EduPoint host (example: `ks-wic-psv.edupoint.com`)
- **Username** — your StudentVUE student ID
- **Password** — your StudentVUE password

Credentials are kept in memory on your machine for the active session only. They are not written to disk.

## Features

- Dashboard with grade overview cards
- Gradebook with reporting period selector and expandable assignment lists
- Attendance view
- Responsive layout inspired by PowerSchool / Infinite Campus

## How it works

StudentVUE mobile apps use EduPoint's `PXPCommunication.asmx/ProcessWebServiceRequest` endpoint. BetterVUE uses the same API through a local proxy so your browser never talks to EduPoint directly and CORS is not an issue.

## Notes

- Some districts disable optional endpoints like schedule or homework lists; BetterVUE handles those gracefully.
- This is an unofficial client and is not affiliated with Edupoint or Synergy.

## License

MIT
