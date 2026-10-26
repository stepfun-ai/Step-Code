/**
 * `#voiceButton`: the composer's microphone button, in `.composer-right`
 * beside the model menu.
 *
 * One click starts a dictation (host session + microphone + event stream),
 * the next click — or the pill's done button — stops it and inserts the
 * final transcript; the pill's cancel button and Escape discard the recording
 * instead. Final transcripts are handed to the composer, which inserts them
 * at the caret and re-syncs its send state, so a dictated prompt behaves
 * exactly like a typed one. While a turn runs the button stays enabled:
 * dictated text queues like typed text.
 *
 * The recording state is local to this component; the shell's Escape chain
 * reaches it through `requestVoiceStop`, not through the global store.
 */

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { cx } from "../../lib/format";
import { showError } from "../../state/session";
import type { VoiceStatus } from "../../state/types";
import { Icon, IconButton, Spinner, Tooltip } from "../../ui";
import { setVoiceStopHook, type VoicePhase, VoiceRecorder, voiceStatus } from "./actions";
import "./voice.css";

export interface MicButtonProps {
	/** A final transcript: the composer inserts it and re-syncs `hasText`. */
	readonly onTranscript: (text: string) => void;
}

/** Host and client failure codes the button translates into guidance. */
const ERROR_KEYS: Readonly<Record<string, string>> = {
	"mic-denied": "voiceMicDenied",
	"capture-failed": "voiceCaptureFailed",
	"no-credential": "voiceNoCredential",
	unreachable: "voiceUnreachable",
	"asr-failed": "voiceAsrFailed",
	"chunk-failed": "voiceChunkFailed",
	"no-speech": "voiceNoSpeech",
};

/**
 * Per-bar sensitivity of the recording waveform. Uneven gains keep the row
 * alive even at a steady level; the live level scales all of them together.
 */
const WAVE_GAINS = [0.55, 0.85, 1, 0.8, 0.6] as const;

/** `mm:ss` for the pill's elapsed counter. */
function formatElapsed(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function MicButton({ onTranscript }: MicButtonProps) {
	const t = useT();
	const [phase, setPhase] = useState<VoicePhase>("idle");
	const [status, setStatus] = useState<VoiceStatus | undefined>();
	const [level, setLevel] = useState(0);
	const [elapsed, setElapsed] = useState(0);
	const recorder = useRef<VoiceRecorder | undefined>(undefined);

	useEffect(() => {
		const controller = new AbortController();
		voiceStatus(controller.signal).then(setStatus, () => setStatus({ available: false }));
		return () => controller.abort();
	}, []);

	const ensureRecorder = useCallback(() => {
		recorder.current ??= new VoiceRecorder({
			onPhase: setPhase,
			onLevel: setLevel,
			onFinal: onTranscript,
			onError: (code, reason) => {
				const key = ERROR_KEYS[code];
				showError(key ? t(key) : t("voiceFailed", { reason }));
			},
		});
		return recorder.current;
	}, [onTranscript, t]);

	// Escape discards a live recording from the shell's chain (repo convention 9).
	// Bound for `connecting` and `transcribing` too: the documented promise is
	// that Escape cancels the dictation, and during those waits it is the only
	// way out — the pill shows a spinner, not a cancel button.
	useEffect(() => {
		if (phase === "idle") return;
		const voice = ensureRecorder();
		setVoiceStopHook(() => voice.cancel());
		return () => setVoiceStopHook(undefined);
	}, [phase, ensureRecorder]);

	// Leaving the composer mid-recording must not keep the microphone open.
	useEffect(
		() => () => {
			void recorder.current?.cancel();
		},
		[],
	);

	// The elapsed counter runs only while the microphone is live.
	useEffect(() => {
		if (phase !== "listening") return;
		setElapsed(0);
		const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
		return () => clearInterval(timer);
	}, [phase]);

	const available = status?.available === true;
	// Unavailable (no credential, or the status query has not answered yet)
	// hides the button outright: a permanently disabled microphone in the
	// composer only invites questions.
	if (!available) return null;

	const connecting = phase === "connecting";
	const listening = phase === "listening";
	const transcribing = phase === "transcribing";
	const label = connecting ? t("voiceConnecting") : listening ? t("voiceStop") : t("voiceStart");
	const hint = listening ? t("voiceListening") : label;

	const button = (
		<IconButton
			id="voiceButton"
			className={cx("voice-button", listening && "voice-button--listening")}
			icon={connecting || transcribing ? undefined : "mic"}
			iconSize={"lg"}
			aria-label={label}
			disabled={connecting || transcribing}
			onClick={() => {
				const voice = ensureRecorder();
				if (listening || connecting) void voice.stop();
				else void voice.start();
			}}
		>
			{connecting || transcribing ? <Spinner /> : null}
		</IconButton>
	);

	return (
		<div className="voice-anchor">
			{listening || transcribing ? (
				<output className="voice-pill" aria-label={t("voiceRecording")}>
					{listening ? (
						<>
							<div className="voice-wave" aria-hidden="true">
								{WAVE_GAINS.map((gain) => (
									<span key={gain} style={{ "--bar-gain": gain, "--bar-level": level } as CSSProperties} />
								))}
							</div>
							<span className="voice-elapsed">{formatElapsed(elapsed)}</span>
							<button
								type="button"
								className="voice-pill-action voice-pill-cancel"
								aria-label={t("voiceCancel")}
								onClick={() => void ensureRecorder().cancel()}
							>
								<Icon name="close" size="xs" />
							</button>
							<button
								type="button"
								className="voice-pill-action voice-pill-done"
								aria-label={t("voiceDone")}
								onClick={() => void ensureRecorder().stop()}
							>
								<Icon name="check" size="xs" />
							</button>
						</>
					) : (
						<>
							<Spinner />
							<span className="voice-pill-label">{t("voiceTranscribing")}</span>
						</>
					)}
				</output>
			) : null}
			{listening || transcribing ? button : <Tooltip content={hint}>{button}</Tooltip>}
		</div>
	);
}
