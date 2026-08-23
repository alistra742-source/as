# as — Captcha Trainer

A small, dependency-free web app for practicing human-verification ("CAPTCHA") challenges.

## Features

- **Trainer tab** — a reCAPTCHA-style flow:
  - Click the **"I'm not a robot" checkbox** → it verifies successfully and unlocks the challenges.
  - Solve 3×3 image challenges ("Select all squares with …"), with verify/next, progress dots, and persistent progress (localStorage).
- **Data tab** — **all** image challenges in the dataset, each with its full answer key (target squares highlighted, optional/partial squares marked), stats, and a "Practice this challenge" shortcut.
- **Discord button** — in the header and footer, takes you straight to the Discord registration page (<https://discord.com/register>).

## Run locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static file server works — there is no build step.

## Dataset

| Challenge      | Target squares (of 9) | Optional squares |
| -------------- | --------------------- | ---------------- |
| traffic lights | 5                     | 2                |
| bicycles       | 4                     | –                |
| crosswalks     | 5                     | –                |
| fire hydrants  | 4                     | –                |
| buses          | 4                     | –                |
| boats          | 4                     | 1                |

"Optional" squares only contain a tiny partial glimpse of the target — selecting them or not never affects grading.

Images live in `images/` and are sliced into 3×3 tiles in the browser via CSS (`background-size: 300%`).
