import os
import sys
import time
import threading
import urllib.parse
from datetime import datetime, timedelta
import pyautogui
import customtkinter as ctk
from tkinter import filedialog, messagebox

# Set modern appearance
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("green")


class AutoMateProApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        # Window Setup
        self.title("AutoMate Pro - WhatsApp Desktop Automation")
        self.geometry("1020x760")
        self.minsize(920, 680)

        # State Variables
        self.is_running = False
        self.stop_requested = False
        self.scheduled_job_active = False

        self.setup_ui()
        self.start_clock_daemon()

    def setup_ui(self):
        # 1. Top Navbar / Header
        self.build_header()

        # 2. Main Content Layout (Two Columns)
        self.body_frame = ctk.CTkFrame(self, fg_color="transparent")
        self.body_frame.pack(fill="both", expand=True, padx=22, pady=(0, 15))

        # Left Panel (Contacts)
        self.build_contacts_panel()

        # Right Panel (Composer, Schedule, Actions, Logs)
        self.build_action_panel()

    def build_header(self):
        header_card = ctk.CTkFrame(self, fg_color="#13171F", corner_radius=14, border_width=1, border_color="#242B38")
        header_card.pack(fill="x", padx=22, pady=(15, 12))

        # Left Header Branding
        brand_box = ctk.CTkFrame(header_card, fg_color="transparent")
        brand_box.pack(side="left", padx=18, pady=12)

        title_lbl = ctk.CTkLabel(
            brand_box,
            text="💬 AutoMate Pro",
            font=ctk.CTkFont(size=22, weight="bold"),
            text_color="#25D366"
        )
        title_lbl.pack(anchor="w")

        sub_lbl = ctk.CTkLabel(
            brand_box,
            text="Automated WhatsApp Desktop Dispatcher • Instant & Scheduled",
            font=ctk.CTkFont(size=12),
            text_color="#8B949E"
        )
        sub_lbl.pack(anchor="w")

        # Right Header Badges
        badge_box = ctk.CTkFrame(header_card, fg_color="transparent")
        badge_box.pack(side="right", padx=18, pady=12)

        self.clock_lbl = ctk.CTkLabel(
            badge_box,
            text="🕒 00:00:00",
            font=ctk.CTkFont(family="Consolas", size=13, weight="bold"),
            text_color="#C9D1D9",
            fg_color="#1E2430",
            corner_radius=8,
            padx=10,
            pady=4
        )
        self.clock_lbl.pack(side="left", padx=(0, 10))

        status_badge = ctk.CTkLabel(
            badge_box,
            text="🟢 Desktop App Ready",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#25D366",
            fg_color="#102E23",
            corner_radius=8,
            padx=10,
            pady=4
        )
        status_badge.pack(side="left")

    def build_contacts_panel(self):
        left_card = ctk.CTkFrame(self.body_frame, fg_color="#13171F", corner_radius=14, border_width=1, border_color="#242B38", width=340)
        left_card.pack(side="left", fill="both", expand=False, padx=(0, 10))
        left_card.pack_propagate(False)

        # Card Title
        hdr = ctk.CTkFrame(left_card, fg_color="transparent")
        hdr.pack(fill="x", padx=15, pady=(15, 6))

        ctk.CTkLabel(
            hdr,
            text="📱 Recipients (Contacts)",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color="#F0F6FC"
        ).pack(side="left")

        # Tip
        tip_box = ctk.CTkFrame(left_card, fg_color="#1A212D", corner_radius=8)
        tip_box.pack(fill="x", padx=15, pady=(0, 8))
        ctk.CTkLabel(
            tip_box,
            text="💡 Ek line me ek number likhein\n(+91 nahi likhenge toh auto lag jayega)",
            font=ctk.CTkFont(size=11),
            text_color="#8B949E",
            justify="left"
        ).pack(padx=10, pady=6, anchor="w")

        # Numbers Textbox
        self.numbers_txt = ctk.CTkTextbox(
            left_card,
            font=("Consolas", 13),
            fg_color="#0D1117",
            border_width=1,
            border_color="#30363D",
            corner_radius=10
        )
        self.numbers_txt.pack(fill="both", expand=True, padx=15, pady=(0, 6))
        
        # Numbers Textbox (Khali by default)
        self.numbers_txt.bind("<KeyRelease>", self.update_contacts_count)

        # Counter Badge
        self.contacts_count_badge = ctk.CTkLabel(
            left_card,
            text="🎯 0 Contacts Detected",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#58A6FF",
            fg_color="#162238",
            corner_radius=6,
            padx=8,
            pady=3
        )
        self.contacts_count_badge.pack(anchor="w", padx=15, pady=(2, 10))

        # Action Buttons Row
        btn_grid = ctk.CTkFrame(left_card, fg_color="transparent")
        btn_grid.pack(fill="x", padx=15, pady=(0, 15))

        ctk.CTkButton(
            btn_grid,
            text="📁 Import File",
            font=ctk.CTkFont(size=12, weight="bold"),
            fg_color="#21262D",
            hover_color="#30363D",
            height=32,
            width=90,
            command=self.import_file
        ).pack(side="left", padx=(0, 4))

        ctk.CTkButton(
            btn_grid,
            text="📋 Paste",
            font=ctk.CTkFont(size=12, weight="bold"),
            fg_color="#21262D",
            hover_color="#30363D",
            height=32,
            width=80,
            command=self.paste_clipboard
        ).pack(side="left", padx=(0, 4))

        ctk.CTkButton(
            btn_grid,
            text="🗑️ Clear",
            font=ctk.CTkFont(size=12, weight="bold"),
            fg_color="#382126",
            hover_color="#522C33",
            text_color="#F85149",
            height=32,
            width=70,
            command=self.clear_contacts
        ).pack(side="right")

    def build_action_panel(self):
        right_container = ctk.CTkFrame(self.body_frame, fg_color="transparent")
        right_container.pack(side="right", fill="both", expand=True)

        # 1. Message Composer Card
        composer_card = ctk.CTkFrame(right_container, fg_color="#13171F", corner_radius=14, border_width=1, border_color="#242B38")
        composer_card.pack(fill="x", pady=(0, 10))

        comp_hdr = ctk.CTkFrame(composer_card, fg_color="transparent")
        comp_hdr.pack(fill="x", padx=15, pady=(12, 6))

        ctk.CTkLabel(
            comp_hdr,
            text="✍️ Message Composer",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color="#F0F6FC"
        ).pack(side="left")

        ctk.CTkButton(
            comp_hdr,
            text="🗑️ Clear Text",
            font=ctk.CTkFont(size=11, weight="bold"),
            fg_color="#21262D",
            hover_color="#30363D",
            width=85,
            height=26,
            command=self.clear_message
        ).pack(side="right")

        # Message Textbox (Khali by default)
        self.msg_txt = ctk.CTkTextbox(
            composer_card,
            height=140,
            font=("Segoe UI", 13),
            fg_color="#0D1117",
            border_width=1,
            border_color="#30363D",
            corner_radius=10
        )
        self.msg_txt.pack(fill="x", padx=15, pady=(0, 6))
        self.msg_txt.bind("<KeyRelease>", self.update_char_count)

        # Quick Emoji Bar & Character Counter
        footer_row = ctk.CTkFrame(composer_card, fg_color="transparent")
        footer_row.pack(fill="x", padx=15, pady=(0, 10))

        emoji_bar = ctk.CTkFrame(footer_row, fg_color="transparent")
        emoji_bar.pack(side="left")

        for emoji in ["❤️", "🎂", "🎉", "✨", "🌸", "💖", "🙏", "🥳", "💐"]:
            ctk.CTkButton(
                emoji_bar,
                text=emoji,
                width=28,
                height=26,
                font=ctk.CTkFont(size=13),
                fg_color="#1C2128",
                hover_color="#2D333B",
                command=lambda e=emoji: self.insert_emoji(e)
            ).pack(side="left", padx=2)

        self.char_count_lbl = ctk.CTkLabel(
            footer_row,
            text="Chars: 0 | Words: 0",
            font=ctk.CTkFont(size=11),
            text_color="#8B949E"
        )
        self.char_count_lbl.pack(side="right")
        self.update_char_count()

        # 2. Dispatch Controls (Mode + Scheduling)
        controls_card = ctk.CTkFrame(right_container, fg_color="#13171F", corner_radius=14, border_width=1, border_color="#242B38")
        controls_card.pack(fill="x", pady=(0, 10))

        dispatch_hdr = ctk.CTkFrame(controls_card, fg_color="transparent")
        dispatch_hdr.pack(fill="x", padx=15, pady=(12, 6))

        ctk.CTkLabel(
            dispatch_hdr,
            text="🚀 Dispatch Settings",
            font=ctk.CTkFont(size=14, weight="bold"),
            text_color="#F0F6FC"
        ).pack(side="left")

        # Mode Segmented Button
        self.mode_segment = ctk.CTkSegmentedButton(
            dispatch_hdr,
            values=["⚡ Send Immediately", "⏰ Schedule Time"],
            font=ctk.CTkFont(size=12, weight="bold"),
            selected_color="#25D366",
            selected_hover_color="#1EA952",
            unselected_color="#1C2128",
            unselected_hover_color="#2D333B",
            command=self.on_mode_change
        )
        self.mode_segment.pack(side="right")
        self.mode_segment.set("⚡ Send Immediately")

        # Schedule Config Box (shows hour/min + live countdown)
        self.sched_frame = ctk.CTkFrame(controls_card, fg_color="#181F2A", corner_radius=10)
        self.sched_frame.pack(fill="x", padx=15, pady=(0, 10))

        sched_inner = ctk.CTkFrame(self.sched_frame, fg_color="transparent")
        sched_inner.pack(fill="x", padx=12, pady=10)

        ctk.CTkLabel(sched_inner, text="Hour (0-23):", font=ctk.CTkFont(size=12, weight="bold")).pack(side="left", padx=(0, 4))
        self.hour_menu = ctk.CTkOptionMenu(
            sched_inner,
            values=[f"{h:02d}" for h in range(24)],
            width=65,
            height=28,
            fg_color="#21262D",
            command=lambda _: self.update_countdown_label()
        )
        self.hour_menu.pack(side="left", padx=(0, 12))
        self.hour_menu.set("00")

        ctk.CTkLabel(sched_inner, text="Minute (0-59):", font=ctk.CTkFont(size=12, weight="bold")).pack(side="left", padx=(0, 4))
        self.minute_menu = ctk.CTkOptionMenu(
            sched_inner,
            values=[f"{m:02d}" for m in range(60)],
            width=65,
            height=28,
            fg_color="#21262D",
            command=lambda _: self.update_countdown_label()
        )
        self.minute_menu.pack(side="left", padx=(0, 15))
        self.minute_menu.set("00")

        self.countdown_lbl = ctk.CTkLabel(
            sched_inner,
            text="⏱️ Midnight Wish (Raat 12:00 AM)",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#58A6FF"
        )
        self.countdown_lbl.pack(side="left")

        # Hide schedule frame initially
        self.sched_frame.pack_forget()

        # Action Buttons (Start / Stop)
        action_bar = ctk.CTkFrame(controls_card, fg_color="transparent")
        action_bar.pack(fill="x", padx=15, pady=(0, 10))

        self.start_btn = ctk.CTkButton(
            action_bar,
            text="🚀 Start Automation",
            font=ctk.CTkFont(size=14, weight="bold"),
            fg_color="#25D366",
            hover_color="#1EA952",
            text_color="#0B0E14",
            height=40,
            command=self.start_automation
        )
        self.start_btn.pack(side="left", fill="x", expand=True, padx=(0, 10))

        self.stop_btn = ctk.CTkButton(
            action_bar,
            text="🛑 Stop Execution",
            font=ctk.CTkFont(size=13, weight="bold"),
            fg_color="#382126",
            hover_color="#522C33",
            text_color="#F85149",
            height=40,
            width=140,
            command=self.stop_automation,
            state="disabled"
        )
        self.stop_btn.pack(side="right")

        # Progress Bar & Status
        prog_row = ctk.CTkFrame(controls_card, fg_color="transparent")
        prog_row.pack(fill="x", padx=15, pady=(0, 12))

        self.progress_bar = ctk.CTkProgressBar(prog_row, height=8, progress_color="#25D366", fg_color="#21262D")
        self.progress_bar.pack(fill="x", pady=(0, 4))
        self.progress_bar.set(0)

        self.prog_status_lbl = ctk.CTkLabel(
            prog_row,
            text="Status: Ready to dispatch",
            font=ctk.CTkFont(size=11),
            text_color="#8B949E"
        )
        self.prog_status_lbl.pack(anchor="w")

        # 3. Live Activity Console Card
        log_card = ctk.CTkFrame(right_container, fg_color="#13171F", corner_radius=14, border_width=1, border_color="#242B38")
        log_card.pack(fill="both", expand=True)

        log_hdr = ctk.CTkFrame(log_card, fg_color="transparent")
        log_hdr.pack(fill="x", padx=15, pady=(10, 4))

        ctk.CTkLabel(
            log_hdr,
            text="📋 Live Activity Log",
            font=ctk.CTkFont(size=13, weight="bold"),
            text_color="#F0F6FC"
        ).pack(side="left")

        ctk.CTkButton(
            log_hdr,
            text="Clear Log",
            font=ctk.CTkFont(size=11),
            fg_color="#21262D",
            hover_color="#30363D",
            width=65,
            height=24,
            command=lambda: self.log_txt.delete("1.0", "end")
        ).pack(side="right")

        self.log_txt = ctk.CTkTextbox(
            log_card,
            font=("Consolas", 11),
            fg_color="#0D1117",
            border_width=1,
            border_color="#30363D",
            corner_radius=10
        )
        self.log_txt.pack(fill="both", expand=True, padx=15, pady=(0, 12))
        self.log("AutoMate Pro initialized. WhatsApp Desktop App ready.")

    # ---------------- UI Event Handlers ---------------- #
    def log(self, text):
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.log_txt.insert("end", f"[{timestamp}] {text}\n")
        self.log_txt.see("end")

    def insert_emoji(self, emoji):
        self.msg_txt.insert("insert", emoji)
        self.update_char_count()

    def update_char_count(self, event=None):
        content = self.msg_txt.get("1.0", "end-1c")
        chars = len(content)
        words = len(content.split())
        self.char_count_lbl.configure(text=f"Chars: {chars} | Words: {words}")

    def update_contacts_count(self, event=None):
        raw_list = [n.strip() for n in self.numbers_txt.get("1.0", "end").splitlines() if n.strip()]
        self.contacts_count_badge.configure(text=f"🎯 {len(raw_list)} Contacts Detected")

    def clear_contacts(self):
        self.numbers_txt.delete("1.0", "end")
        self.update_contacts_count()

    def paste_clipboard(self):
        try:
            cb_text = self.clipboard_get()
            self.numbers_txt.insert("end", "\n" + cb_text)
            self.update_contacts_count()
        except:
            pass

    def import_file(self):
        path = filedialog.askopenfilename(filetypes=[("Text / CSV", "*.txt;*.csv"), ("All", "*.*")])
        if path:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = f.read()
                self.numbers_txt.delete("1.0", "end")
                self.numbers_txt.insert("1.0", data)
                self.update_contacts_count()
                self.log(f"📁 Imported numbers from {os.path.basename(path)}")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to read file: {e}")

    def clear_message(self):
        self.msg_txt.delete("1.0", "end")
        self.update_char_count()

    def on_mode_change(self, mode):
        if mode == "⏰ Schedule Time":
            self.sched_frame.pack(fill="x", padx=15, pady=(0, 10))
            self.update_countdown_label()
        else:
            self.sched_frame.pack_forget()

    def update_countdown_label(self):
        try:
            th = int(self.hour_menu.get())
            tm = int(self.minute_menu.get())
            now = datetime.now()
            target = now.replace(hour=th, minute=tm, second=0, microsecond=0)
            if target <= now:
                target += timedelta(days=1)
            diff = target - now
            hours, remainder = divmod(diff.seconds, 3600)
            minutes, _ = divmod(remainder, 60)
            self.countdown_lbl.configure(text=f"⏱️ Schedule in: {hours}h {minutes}m ({th:02d}:{tm:02d})")
        except:
            pass

    def start_clock_daemon(self):
        def clock_tick():
            while True:
                now_str = datetime.now().strftime("🕒 %H:%M:%S")
                try:
                    self.clock_lbl.configure(text=now_str)
                except:
                    break
                time.sleep(1)

        threading.Thread(target=clock_tick, daemon=True).start()

    # ---------------- Automation Engine ---------------- #
    def start_automation(self):
        raw_numbers = [n.strip() for n in self.numbers_txt.get("1.0", "end").splitlines() if n.strip()]
        message = self.msg_txt.get("1.0", "end-1c").strip()

        if not raw_numbers:
            messagebox.showwarning("Numbers Missing", "Kripya kam se kam ek phone number daalein!")
            return

        if not message:
            messagebox.showwarning("Message Missing", "Message box khali hai, kripya message likhein!")
            return

        self.is_running = True
        self.stop_requested = False
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.progress_bar.set(0)

        mode = self.mode_segment.get()

        worker = threading.Thread(
            target=self.run_engine,
            args=(raw_numbers, message, mode),
            daemon=True
        )
        worker.start()

    def stop_automation(self):
        if self.is_running:
            self.stop_requested = True
            self.log("🛑 Stop request received. Rokne ka prayas kar rahe hain...")
            self.prog_status_lbl.configure(text="Status: Stopping...")

    def run_engine(self, numbers_raw, message, mode):
        # 1. Schedule Wait (if scheduled)
        if mode == "⏰ Schedule Time":
            target_hour = int(self.hour_menu.get())
            target_minute = int(self.minute_menu.get())
            self.log(f"⏰ Scheduled for {target_hour:02d}:{target_minute:02d}. Intezar kar rahe hain...")
            self.prog_status_lbl.configure(text=f"Status: Waiting for {target_hour:02d}:{target_minute:02d}...")

            while not self.stop_requested:
                now = datetime.now()
                if now.hour == target_hour and now.minute == target_minute:
                    self.log(f"🎯 Target time ho gaya ({now.strftime('%H:%M:%S')})! Dispatch shuru...")
                    break
                time.sleep(1)

            if self.stop_requested:
                self.log("❌ Schedule cancelled before start.")
                self.finish_engine()
                return

        # 2. Sequential Send
        total = len(numbers_raw)
        encoded_msg = urllib.parse.quote(message)

        for index, raw in enumerate(numbers_raw, start=1):
            if self.stop_requested:
                self.log("🛑 Process user dwara roki gayi.")
                break

            clean_num = "".join(c for c in str(raw) if c.isdigit())
            if len(clean_num) == 10:
                clean_num = "91" + clean_num

            self.log(f"[{index}/{total}] WhatsApp open kar rahe hain: +{clean_num}")
            self.prog_status_lbl.configure(text=f"Status: Sending to +{clean_num} ({index}/{total})...")

            try:
                whatsapp_url = f"whatsapp://send?phone={clean_num}&text={encoded_msg}"
                os.startfile(whatsapp_url)

                # Pehle contact ke liye 7s wait, agle contacts ke liye 4s
                wait_time = 7 if index == 1 else 4
                for _ in range(wait_time * 2):
                    if self.stop_requested:
                        break
                    time.sleep(0.5)

                if self.stop_requested:
                    break

                # Send enter twice to ensure delivery and prevent draft state
                pyautogui.press("enter")
                time.sleep(0.5)
                pyautogui.press("enter")

                self.log(f"-> +{clean_num} ko successfully bhej diya gaya! ✅")
                self.progress_bar.set(index / total)

                # Contact spacing delay
                time.sleep(2)

            except Exception as e:
                self.log(f"❌ Error aaya +{clean_num}: {e}")

        if not self.stop_requested:
            self.log("🎉 Sabhi messages successfully deliver ho gaye!")
            self.prog_status_lbl.configure(text="Status: Completed! All messages sent.")
            messagebox.showinfo("Success", "Sabhi WhatsApp messages safaltapoorvak bhej diye gaye!")
        else:
            self.prog_status_lbl.configure(text="Status: Stopped by user.")

        self.finish_engine()

    def finish_engine(self):
        self.is_running = False
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")


if __name__ == "__main__":
    app = AutoMateProApp()
    app.mainloop()
