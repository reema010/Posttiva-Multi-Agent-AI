# Posttiva Frontend

This folder contains the browser-based frontend for Posttiva.

- `index.html` - entry point
- `app.js` - application flow and UI state
- `api.js` - AI and database API client
- `config.js` - backend URLs
- `styles.css`, `screens.css`, `extras.css` - styling

For full project architecture, setup, models, and results, see the repository-level [`README.md`](../README.md).

To serve the frontend locally:

```bash
cd Posttiva
python -m http.server 8080
```

Then open `http://localhost:8080`.
