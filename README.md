# 💬 AutoMate Pro & AutoMate Cloud
### 24/7 WhatsApp Automation, Bulk Broadcast & Cloud Scheduler

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Multi--Device-25D366.svg)](https://web.whatsapp.com/)
[![Supabase](https://img.shields.io/badge/Database-Supabase%20PostgreSQL-3ECF8E.svg)](https://supabase.com/)
[![Render](https://img.shields.io/badge/Deploy-Render%20Cloud-black.svg)](https://render.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **AutoMate** is an enterprise-grade, zero-cost WhatsApp automation suite offering both a **24/7 Cloud Web App** and a **Standalone Windows Desktop App (`.exe`)**. Broadcast messages immediately or schedule automated broadcasts 24/7 on the cloud—even when your phone or laptop is completely powered off!

---

## 🌐 Live Cloud Web App
👉 **[Open AutoMate Cloud](https://whatsapp-automation-and-bulk-message.onrender.com/)**

---

## ✨ Key Features

### 1. 🎨 Official WhatsApp Color Palette (Dark & Light Modes)
* **WhatsApp Official Dark Theme (`#111b21`, `#202c33`, `#00a884`)**: Sleek, immersive dark mode designed for eye comfort.
* **WhatsApp Official Light Theme (`#efeae2`, `#ffffff`, `#008069`)**: Authentic chat wallpaper beige background with crisp white panels and classic WhatsApp green accents.
* **1-Click Theme Switcher**: Toggle between Dark and Light mode instantly from the top navigation bar with preferences saved in `localStorage`.

### 2. 📱 Two Effortless Linking Methods
* **📷 Scan QR Code:** Link using a second screen or PC camera via WhatsApp Linked Devices.
* **🔢 8-Digit Phone Pairing Code:** Link directly on the **same mobile phone** without needing a second screen or camera! Enter your phone number, get an 8-digit code, and enter it directly in WhatsApp.

### 3. 👥 Multi-Tenant & Device-Isolated Architecture
* **Zero Cross-Talk:** Every device (phone, laptop, tablet) automatically generates a persistent, unique Device ID (`dev_xxxxxx`).
* **Complete Privacy:** User A and User B accessing the website at the same time receive completely isolated WhatsApp sockets, separate scheduled jobs, and independent delivery histories.

### 4. 🛡️ Bank-Grade Security & Zero-Knowledge Privacy
* **Supabase PostgreSQL with RLS (Row-Level Security):** Data is isolated at the database level.
* **Zero Chat Snooping:** Messages and chats are never read, accessed, or sold. Sockets only transmit the exact text you explicitly compose.
* **No Passwords or OTPs:** Uses WhatsApp's official Multi-Device encrypted protocol.
* **1-Click Data Wipe:** A dedicated **"Wipe All My Data & Disconnect"** button permanently removes all your tasks, delivery records, and unlinks your credentials in 1 second.

### 5. 🚀 High-Concurrency Worker Pool & Pre-Warming
* **Memory-Safe Worker Pool:** Limits concurrent dispatch to 8 workers, keeping RAM under 250 MB on free cloud tiers (preventing Out-Of-Memory crashes).
* **Smart Pre-Warming (T-35s before midnight):** Automatically establishes the WhatsApp WebSocket 35 seconds before the scheduled time (e.g. 11:59:25 PM) so messages dispatch within **2 seconds of 12:00:00 AM**!
* **Atomic Idempotent Locking:** Ensures no recipient ever receives a duplicate message.

### 6. 🛡️ Anti-Ban Human Jitter Engine
* **Typing Status Simulation:** Emits `sock.sendPresenceUpdate('composing')` 1.2 seconds before dispatching the message packet.
* **Randomized Intervals:** Delays successive sends by a dynamic 3.0s to 5.5s window to simulate natural human messaging patterns.
* **Isolated Try-Catch:** If a landline or invalid contact fails, the rest of the batch continues delivering without interruption.

### 7. 💻 Standalone Desktop App (`AutoMate_Pro.zip`)
* Pre-compiled standalone Windows application (`AutoMate_App.exe`).
* Uses local Windows WhatsApp Desktop automation for 100% offline, zero-server-cost bulk sending.

---

## 🛠️ Project Structure

```
├── AutoMate_App.exe          # Compiled Standalone Windows Desktop App
├── AutoMate_App.py           # Python Source for Desktop Automation
├── AutoMate_Pro.zip          # Packaged Desktop Application Suite
├── package.json              # Root build & start scripts
├── run_web_app.bat           # 1-Click Windows Batch Runner
├── web_app/
│   ├── db.js                 # Resilient Database Adapter (Supabase + Local Fallback)
│   ├── package.json          # Node.js Dependencies
│   ├── server.js             # Baileys WhatsApp Engine, Worker Pool & Express API
│   ├── supabase_schema.sql   # SQL Schema with Atomic Locks, Indexing & Retention
│   └── public/
│       ├── app.js            # Client Engine, Modals, Device Session & Theme Controller
│       ├── index.html        # Glassmorphic UI with Modals System
│       └── style.css         # WhatsApp Official Dark & Light Design System
└── .gitignore                # Airtight ignore rules protecting all credentials & .env
```

---

## 🚀 Quick Start (Local Setup)

### Prerequisites
* [Node.js](https://nodejs.org/) v18 or higher
* [Git](https://git-scm.com/)

### 1. Clone & Install
```bash
git clone https://github.com/Aadarsh2021/Whatsapp-Automation-and-bulk-message-sender.git
cd Whatsapp-Automation-and-bulk-message-sender
npm install
cd web_app && npm install
```

### 2. Configure Environment Variables (Optional for Supabase)
Create a `.env` file inside `web_app/`:
```env
PORT=3000
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-supabase-secret-key
```
*(Note: If no Supabase key is provided, the application automatically runs in Local Resilient Fallback mode with zero crashes).*

### 3. Run the Web Server
```bash
npm start
```
Open your browser and navigate to **`http://localhost:3000`**.

---

## 🗄️ Supabase Database Setup

To enable cloud persistence across server restarts:
1. Open the **SQL Editor** in your [Supabase Dashboard](https://supabase.com/dashboard).
2. Copy and paste the contents of [`web_app/supabase_schema.sql`](web_app/supabase_schema.sql).
3. Click **Run**. This will create:
   * `scheduled_tasks` table with atomic locks.
   * `delivery_history` table with auto-retention cleanup.
   * Performance indexes for lightning-fast midnight queries.
   * Row-Level Security (RLS) policies.

---

## ☁️ Deployment on Render (Free Tier)

This repository is optimized for **1-click auto-deployment** on [Render](https://render.com/):

1. Create a new **Web Service** on Render connected to this GitHub repo.
2. Configure settings:
   * **Runtime:** `Node`
   * **Build Command:** `cd web_app && npm install`
   * **Start Command:** `node web_app/server.js`
3. Add Environment Variables in Render:
   * `SUPABASE_URL`: `https://your-project.supabase.co`
   * `SUPABASE_KEY`: `your-supabase-secret-key`
4. Set up an external ping service (e.g. [UptimeRobot](https://uptimerobot.com/)) pointing to `https://your-app.onrender.com/api/health` every 10 minutes to maintain **24/7 zero-sleep availability**.

---

## 🔒 Security & Privacy Notice
* **Zero Credentials Stored in Git:** All session tokens and `.env` files are strictly excluded via `.gitignore`.
* **Instant Revocation:** You can disconnect or revoke access at any time directly from your mobile phone via **WhatsApp > Settings > Linked Devices > Log out**.
* **Educational & Productivity Use:** This software is intended for personal scheduling, birthday wishes, team updates, and automated reminders. Please comply with WhatsApp's Terms of Service and avoid spamming.

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
