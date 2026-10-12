# Working preferences

- For UI-related changes, do not verify with screenshots or browser-based visual checks. Finish the change, run the relevant non-visual tests, then report back — the user will verify the UI themselves.
- The user manages the dev servers (`npm run dev`) manually. Never leave the app running: if a task requires starting it, stop every related process (api, web, worker, concurrently, tsx watch) and verify ports 3000/3001/5173 are freed before reporting back.
