# 💬 AutoMate Cloud - 24/7 WhatsApp Web Automation & Scheduler

AutoMate Cloud ek modern, full-stack Web Application hai jo kisi bhi device (Mobile, iPhone, Tablet, Laptop) ke browser se chalta hai aur **24/7 background me messages schedule aur send karta hai**.

---

## 🚀 Key Features

1. **Device Independence:** Kisi bhi phone ya laptop ke browser me chalta hai (Responsive UI).
2. **24/7 Cloud Scheduling:** Message schedule karne ke baad phone ya laptop band bhi ho jaye, server exact time par message bhej deta hai.
3. **No Puppeteer / Browser Automation Needed:** Direct WhatsApp Multi-Device WebSocket protocol (`Baileys`) use karta hai jo fast aur lightweight hai.
4. **Dual Linking Methods:**
   - 📷 **QR Code Scan:** Laptop ya dusre phone se scan karne ke liye.
   - 🔢 **8-Digit Pairing Code:** Usi phone me bina camera ke direct phone number se connect karne ke liye!
5. **Full History & Task Management:** Upcoming scheduled tasks ko cancel kar sakte hain aur sent messages ka live status dekh sakte hain.

---

## 💻 Local Run Kaise Karein (Apne PC pe):

### Option 1: Direct Batch Launcher
Folder me jaakar **[`run_web_app.bat`](file:///c:/Users/thaku/OneDrive/Desktop/autonate/run_web_app.bat)** par double click karein. Ye server start karke browser me `http://localhost:3000` open kar dega.

### Option 2: Terminal se
```powershell
cd web_app
node server.js
```
Phir browser me kholein: `http://localhost:3000`

---

## ☁️ Online 24/7 Deploy Kaise Karein (Free Cloud Server):

Agar aap chahte hain ki ye internet par hamesha chalu rahe taaki aapka laptop band hone par bhi chale:

1. Is `web_app` folder ko **GitHub** pe upload karein.
2. [Render.com](https://render.com) ya [Railway.app](https://railway.app) par free account banayein.
3. "New Web Service" select karein aur apna GitHub repo connect karein:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Render/Railway aapko ek live link de dega (e.g., `https://your-automate.onrender.com`).
5. Ab aap ya aapka koi bhi client apne mobile phone me wo link khol kar WhatsApp connect aur schedule kar sakta hai 24/7!
