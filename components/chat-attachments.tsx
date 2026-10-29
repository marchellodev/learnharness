"use client";

import { useEffect, useRef, useState } from "react";
import { FileTextIcon, PaperclipIcon, RotateCwIcon, XIcon } from "lucide-react";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, type ChatAttachment } from "@/src/core";

const acceptedTypes = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
export const ATTACHMENT_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";

/** Validate before reading so oversized files never become browser data URLs. */
export function validateAttachmentFiles(files: readonly Pick<File, "name" | "type" | "size">[], existing: readonly ChatAttachment[]): void {
	if (files.length + existing.length > MAX_ATTACHMENTS) throw new Error(`Attach up to ${MAX_ATTACHMENTS} files.`);
	let total = existing.reduce((sum, file) => sum + file.data.length * 3 / 4 - (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0), 0);
	for (const file of files) {
		if (!acceptedTypes.has(file.type)) throw new Error(`${file.name}: choose a PDF, PNG, JPEG, or WebP file.`);
		if (!file.size) throw new Error(`${file.name}: this file is empty.`);
		if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name}: files must be 5 MB or smaller.`);
		total += file.size;
	}
	if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments must total 10 MB or less.");
}

function readAttachment(file: File): Promise<ChatAttachment> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(`Could not read ${file.name}. Please try again.`));
		reader.onload = () => {
			const result = String(reader.result);
			resolve({ name: file.name, mimeType: file.type as ChatAttachment["mimeType"], data: result.slice(result.indexOf(",") + 1) });
		};
		reader.readAsDataURL(file);
	});
}

/** A file picked by the macOS attachment menu (electron/continuity-camera.cjs):
 *  data is omitted when the file is over the size limit or of an unsupported type. */
export interface PickedFile {
	name: string;
	type: string;
	size: number;
	data?: string;
}

function fileFromBase64(data: string, name: string, type: string): File {
	return new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], name, { type });
}

function photoName(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `iPhone photo ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.jpg`;
}

/** The image turned a quarter clockwise, re-encoded in its own format. The
 *  decode applies EXIF orientation, so the result is upright as shown. */
export async function rotateAttachment(file: ChatAttachment): Promise<ChatAttachment> {
	const image = new Image();
	image.src = `data:${file.mimeType};base64,${file.data}`;
	await image.decode();
	const canvas = document.createElement("canvas");
	canvas.width = image.naturalHeight;
	canvas.height = image.naturalWidth;
	const context = canvas.getContext("2d");
	if (!context) throw new Error(`Could not rotate ${file.name}.`);
	context.translate(canvas.width, 0);
	context.rotate(Math.PI / 2);
	context.drawImage(image, 0, 0);
	const url = canvas.toDataURL(file.mimeType, 0.92);
	const data = url.slice(url.indexOf(",") + 1);
	if (data.length * 3 / 4 > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name}: the rotated photo is over 5 MB.`);
	return { ...file, data };
}

export function useAttachmentDraft() {
	const [files, setFiles] = useState<ChatAttachment[]>([]);
	const [error, setError] = useState<string>();
	const [reading, setReading] = useState(false);
	const readingRef = useRef(false);
	const add = async (selected: FileList | readonly File[] | null) => {
		if (!selected?.length || readingRef.current) return;
		readingRef.current = true;
		setReading(true);
		setError(undefined);
		try {
			const incoming = Array.from(selected);
			validateAttachmentFiles(incoming, files);
			const loaded = await Promise.all(incoming.map(readAttachment));
			setFiles((current) => [...current, ...loaded]);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			readingRef.current = false;
			setReading(false);
		}
	};
	/* Validate the picked metadata first: oversized files arrive without data. */
	const addPicked = (picked: readonly PickedFile[]) => {
		try {
			validateAttachmentFiles(picked, files);
		} catch (err) {
			setError((err as Error).message);
			return;
		}
		void add(picked.map((file) => fileFromBase64(file.data ?? "", file.name, file.type)));
	};
	return {
		files, error, reading, add, addPicked,
		remove: (file: ChatAttachment) => setFiles((current) => current.filter((item) => item !== file)),
		rotate: async (file: ChatAttachment) => {
			setError(undefined);
			try {
				const rotated = await rotateAttachment(file);
				setFiles((current) => current.map((item) => item === file ? rotated : item));
			} catch (err) {
				setError((err as Error).message);
			}
		},
		accepted: (sent: readonly ChatAttachment[]) => setFiles((current) => current.filter((file) => !sent.includes(file))),
	};
}

/* Only the picker that opened the menu takes the photo: it arrives after
 * the menu has closed, whenever the learner confirms on the phone. */
let cameraTarget: ((file: File) => void) | null = null;

export function AttachmentPicker({ disabled, onFiles, onPicked }: { disabled: boolean; onFiles: (files: FileList | readonly File[] | null) => void; onPicked?: (files: readonly PickedFile[]) => void }) {
	const input = useRef<HTMLInputElement>(null);
	const takePhoto = useRef<(file: File) => void>(() => {});
	useEffect(() => {
		takePhoto.current = (file) => onFiles([file]);
	});
	useEffect(() => window.lh?.onCameraImage?.(({ mimeType, data }) => {
		if (cameraTarget === takePhoto.current) cameraTarget(fileFromBase64(data, photoName(), mimeType));
	}), []);
	useEffect(() => () => {
		if (cameraTarget === takePhoto.current) cameraTarget = null;
	}, []);
	const menu = typeof window !== "undefined" ? window.lh?.attachmentMenu : undefined;
	const open = async (button: HTMLButtonElement) => {
		if (!menu) {
			input.current?.click();
			return;
		}
		const rect = button.getBoundingClientRect();
		cameraTarget = takePhoto.current;
		const picked = await menu(rect.left, rect.top - 4, MAX_ATTACHMENT_BYTES);
		if (picked.kind === "files") onPicked?.(picked.files);
	};
	return (
		<>
			<input
				ref={input} type="file" multiple accept={ATTACHMENT_ACCEPT}
				aria-label="Choose PDFs or photos" className="sr-only" tabIndex={-1}
				onChange={(event) => { onFiles(event.target.files); event.target.value = ""; }}
			/>
			<button
				type="button" aria-label="Attach PDFs or photos"
				title={menu ? "Attach PDFs or photos, or take a photo with your iPhone (up to 4 files, 5 MB each, 10 MB total)" : "Attach PDFs or photos (up to 4 files, 5 MB each, 10 MB total)"}
				disabled={disabled} onClick={(event) => void open(event.currentTarget)}
				className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
			>
				<PaperclipIcon className="size-4" />
			</button>
		</>
	);
}

export function AttachmentPreview({ file }: { file: ChatAttachment }) {
	const uri = `data:${file.mimeType};base64,${file.data}`;
	return (
		<a href={uri} download={file.name} title={`Download ${file.name}`} className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent">
			{file.mimeType.startsWith("image/") ? (
				// Local, bounded data URLs cannot use the Next image optimization server.
				// eslint-disable-next-line @next/next/no-img-element
				<img src={uri} alt={file.name} width={40} height={40} className="size-10 shrink-0 rounded object-cover" />
			) : <FileTextIcon className="size-5 shrink-0" />}
			<span className="truncate">{file.name}</span>
		</a>
	);
}

export function AttachmentTray({ files, error, reading, disabled, waiting = false, onRemove, onRotate }: { files: readonly ChatAttachment[]; error?: string; reading: boolean; disabled: boolean; waiting?: boolean; onRemove: (file: ChatAttachment) => void; onRotate?: (file: ChatAttachment) => void }) {
	if (!files.length && !error && !reading) return null;
	return (
		<div className="px-3 pt-2" aria-live="polite">
			{files.length > 0 && (
				<ul aria-label="Attached files" className="flex flex-wrap gap-2">
					{files.map((file, index) => (
						<li key={index} className="flex min-w-0 max-w-full items-center gap-1">
							<AttachmentPreview file={file} />
							{onRotate && file.mimeType.startsWith("image/") && (
								<button type="button" aria-label={`Rotate ${file.name}`} title="Rotate 90° clockwise" disabled={disabled} onClick={() => onRotate(file)} className="flex size-8 shrink-0 items-center justify-center rounded hover:bg-accent disabled:opacity-40">
									<RotateCwIcon className="size-4" />
								</button>
							)}
							<button type="button" aria-label={`Remove ${file.name}`} disabled={disabled} onClick={() => onRemove(file)} className="flex size-8 shrink-0 items-center justify-center rounded hover:bg-accent disabled:opacity-40">
								<XIcon className="size-4" />
							</button>
						</li>
					))}
				</ul>
			)}
			{reading && <p className="py-1 text-xs text-muted-foreground">Reading attachments…</p>}
			{waiting && <p className="py-1 text-xs text-muted-foreground">Wait for this turn to finish, then send your attachments. Stop is still available.</p>}
			{error && <p role="alert" className="py-1 text-xs text-destructive">{error}</p>}
			{files.length > 0 && <p className="pt-1 text-xs text-muted-foreground">PDF text is included in your message. Scanned PDFs need selectable text. Photos require an image-capable model.</p>}
		</div>
	);
}
