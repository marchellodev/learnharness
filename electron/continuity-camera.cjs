"use strict";
/*
 * The macOS attachment menu (electron/native/continuity-camera.mm): the
 * paperclip opens a native context menu — "Choose File…" plus a nearby
 * iPhone's Take Photo / Scan Documents / Add Sketch. Files are picked and
 * read here (a renderer file input would need a fresh user activation
 * after the menu closes); photos arrive later, whenever the learner
 * confirms on the phone, and go to the window that opened the menu.
 *
 * Without the addon (not built, or failing to load) the paperclip still
 * works: the same handler opens the file dialog directly.
 */
const fs = require("node:fs");
const path = require("node:path");

const TYPES = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const MAX_PICKED = 16;
const MAX_READ_BYTES = 50 * 1024 * 1024;

function loadAddon(app, log) {
	if (process.platform !== "darwin") return null;
	try {
		const dir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "native");
		return require(path.join(dir, "continuity-camera.node"));
	} catch (err) {
		log(`continuity camera unavailable: ${err.message}`);
		return null;
	}
}

function pickedFile(file, maxBytes) {
	const size = fs.statSync(file).size;
	const type = TYPES[path.extname(file).toLowerCase()] ?? "";
	// Oversized files travel as metadata only; the renderer's limits refuse them.
	const data = type && size <= maxBytes ? fs.readFileSync(file).toString("base64") : undefined;
	return { name: path.basename(file), type, size, data };
}

function registerAttachmentMenu({ app, ipcMain, dialog, BrowserWindow, trusted, log }) {
	const addon = loadAddon(app, log);
	let opener = null;
	const ready = addon?.init((jpeg) => {
		if (!opener || opener.isDestroyed()) return;
		opener.send("lh:camera-image", { mimeType: "image/jpeg", data: jpeg.toString("base64") });
	});
	if (addon && !ready) log("continuity camera: Chromium view hook unavailable");

	ipcMain.handle("lh:attachment-menu", async (event, request) => {
		if (!trusted(event)) throw new Error("Untrusted desktop request.");
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return { kind: "none" };
		const x = Number(request?.x), y = Number(request?.y);
		const maxBytes = Math.min(Math.max(Number(request?.maxBytes) || 0, 0), MAX_READ_BYTES);
		if (ready && Number.isFinite(x) && Number.isFinite(y)) {
			opener = event.sender;
			const zoom = event.sender.getZoomFactor();
			const choice = addon.popup(win.getNativeWindowHandle(), x * zoom, y * zoom, {
				file: "Choose File…",
				hint: "Turn on Bluetooth and Wi-Fi to use your iPhone’s camera",
			});
			if (choice !== "file") return { kind: "none" };
		}
		const picked = await dialog.showOpenDialog(win, {
			properties: ["openFile", "multiSelections"],
			filters: [{ name: "PDFs and photos", extensions: ["pdf", "png", "jpg", "jpeg", "webp"] }],
		});
		if (picked.canceled || !picked.filePaths.length) return { kind: "none" };
		return { kind: "files", files: picked.filePaths.slice(0, MAX_PICKED).map((file) => pickedFile(file, maxBytes)) };
	});
}

module.exports = { registerAttachmentMenu };
