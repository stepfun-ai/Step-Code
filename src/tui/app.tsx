/** @jsxImportSource @opentui/react */

import path from "node:path";
import {
  decodePasteBytes,
  type KeyEvent,
  type PasteEvent,
  type ScrollAcceleration,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { UserAttachment } from "@step-cli/protocol";
import { visibleLength } from "@step-cli/utils/display-width.js";
import { parseImageAttachmentInput } from "@step-cli/utils/image-attachments.js";
import {
  describeRunFailure,
  didTurnSucceed,
  formatTuiGoalDetail,
  formatPendingAttachments,
  loadTuiSessionData,
  summarizeTurn,
} from "./gateway-client.js";
import { copyTextToClipboard } from "./clipboard.js";
import {
  applyComposerPaste,
  browseComposerHistory,
  detachComposerHistory,
  rememberSubmittedComposerValue,
} from "./composer-state.js";
import { readSelectedText } from "./selection-copy.js";
import {
  DEFAULT_TUI_THEME_NAME,
  getTuiThemeNames,
  hasTuiTheme,
  mergeTuiThemes,
  resolveTuiTheme,
  type StepCliTuiThemeColors,
  type StepCliTuiThemeName,
} from "./theme.js";
import { compactToolTranscriptContent } from "./transcript-preview.js";
import { buildTranscriptClipboardText } from "./transcript-export.js";
import { buildToolTranscriptLines } from "./tool-call-collapsible.js";
import { buildReasoningTranscriptLines } from "./reasoning-collapsible.js";
import type {
  StepCliTuiComposerState,
  StepCliTuiComposerHistoryState,
  StepCliTuiLastRunState,
  StepCliTuiPendingApproval,
  StepCliTuiPendingAttachment,
  StepCliTuiQueuedTurnEntry,
  StepCliTuiScreenProps,
  StepCliTuiSessionData,
  StepCliTuiStatus,
  StepCliTuiTone,
  StepCliTuiTranscriptEntry,
  VoiceInputMode,
  VoiceRuntimeBundle,
} from "./types.js";
import type { AudioDriver, RealtimeSession } from "@step-cli/realtime";
import {
  isComposerNewlineKey,
  isComposerSubmitKey,
} from "./composer-shortcuts.js";
import { buildTranscriptScrollAcceleration } from "./scroll-config.js";
import { resolveTranscriptPageScrollStep } from "./scroll-speed.js";
import { resolveSlashPaletteWindow } from "./slash-command-state.js";
import {
  TUI_SLASH_COMMAND_DEFINITIONS,
  type SlashCommandDefinition,
} from "./slash-commands.js";

const MAX_ATTACHMENT_PREVIEW = 2;
const MIN_COMPOSER_EDITOR_MAX_HEIGHT = 4;
const MAX_COMPOSER_EDITOR_MAX_HEIGHT = 18;
const COMPOSER_EDITOR_MAX_HEIGHT_RATIO = 0.4;
const MAX_SLASH_COMMAND_ITEMS = 5;
const MAX_QUEUED_TURN_PREVIEW = 3;
const MAX_QUEUED_TURN_LINES = 2;
const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
const SLASH_COMMAND_DEFINITIONS = TUI_SLASH_COMMAND_DEFINITIONS;

export function StepCliTuiScreen(props: StepCliTuiScreenProps) {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const columns = Math.max(40, terminal.width || process.stdout.columns || 120);
  const abortControllersRef = useRef(new Set<AbortController>());
  const activeRunCountRef = useRef(0);
  const transcriptScrollRef = useRef<ScrollBoxRenderable>(null);
  const composerEditorRef = useRef<TextareaRenderable>(null);
  const suppressComposerEditorEventsRef = useRef(false);
  const [themeName, setThemeName] = useState<StepCliTuiThemeName>(
    () => props.initialThemeName ?? DEFAULT_TUI_THEME_NAME,
  );
  const [sessionData, setSessionData] = useState<StepCliTuiSessionData | null>(
    null,
  );
  const [transcriptEntries, setTranscriptEntries] = useState<
    StepCliTuiTranscriptEntry[]
  >(() => props.transcript.getEntries());
  const [queuedTurns, setQueuedTurns] = useState<StepCliTuiQueuedTurnEntry[]>(
    () => props.transcript.getQueuedTurns(),
  );
  const [pendingApproval, setPendingApproval] =
    useState<StepCliTuiPendingApproval | null>(() =>
      props.transcript.getPendingApproval(),
    );
  const [composer, setComposer] = useState<StepCliTuiComposerState>({
    value: "",
    cursorIndex: 0,
  });
  const [composerHistory, setComposerHistory] =
    useState<StepCliTuiComposerHistoryState>({
      entries: [],
      browsingIndex: null,
      draftBeforeBrowsing: null,
    });
  const [pendingAttachments, setPendingAttachments] = useState<
    UserAttachment[]
  >([]);
  const [status, setStatus] = useState<StepCliTuiStatus>({
    tone: "brand",
    label: "Booting",
    detail: "Loading session state",
  });
  const latestNonApprovalStatusRef = useRef<StepCliTuiStatus>({
    tone: "brand",
    label: "Booting",
    detail: "Loading session state",
  });
  const pendingApprovalIdRef = useRef<string | null>(null);
  const [lastRun, setLastRun] = useState<StepCliTuiLastRunState | null>(null);
  const [activeRunCount, setActiveRunCount] = useState(0);
  const [spinnerFrameIndex, setSpinnerFrameIndex] = useState(0);
  const [slashSelectionIndex, setSlashSelectionIndex] = useState(0);
  const [toolOutputExpanded, setToolOutputExpanded] = useState(false);
  const submitting = activeRunCount > 0;

  // Voice mode state. The host passes a loadVoiceRuntime factory; we cache
  // the resolved bundle so /voice can re-enter voice mode without re-opening
  // the WebSocket. autoStartVoice (set by `step voice`) triggers the load on
  // mount; otherwise the user enters voice via the /voice slash command.
  const [voiceRuntime, setVoiceRuntime] = useState<VoiceRuntimeBundle | null>(
    null,
  );
  const [voiceActive, setVoiceActive] = useState<boolean>(false);
  const [voiceLoading, setVoiceLoading] = useState<boolean>(false);
  const [voiceInputMode, setVoiceInputMode] = useState<VoiceInputMode>(
    () => props.initialVoiceMode ?? "duplex",
  );
  const [voiceIsRecording, setVoiceIsRecording] = useState(false);
  const [voiceIsPlaying, setVoiceIsPlaying] = useState(false);
  const pttTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pttLastSpaceRef = useRef(0);
  const voiceRuntimeRef = useRef<VoiceRuntimeBundle | null>(null);
  voiceRuntimeRef.current = voiceRuntime;

  const voiceSession: RealtimeSession | null = voiceActive
    ? (voiceRuntime?.session ?? null)
    : null;
  const voiceDriverForLayer: AudioDriver | null = voiceActive
    ? (voiceRuntime?.audioDriver ?? null)
    : null;
  // duplex auto-records once the session is up; PTT records only while Space
  // is held down (tracked via voiceIsRecording with a 200ms key-repeat debounce).
  const voiceShouldRecord =
    voiceActive && (voiceInputMode === "duplex" || voiceIsRecording);

  // Auto-start voice when the host requested it (i.e. `step voice` flow).
  useEffect(() => {
    if (!props.autoStartVoice) return;
    if (!props.loadVoiceRuntime) return;
    if (voiceRuntime) return;
    void activateVoiceRuntime("autostart");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!voiceActive || !voiceRuntime) return;
    const session = voiceRuntime.session;
    if (voiceInputMode === "duplex") {
      session.beginUserAudio();
    }
    const unsub = session.subscribe((ev) => {
      if (ev.type === "transcript.done") {
        props.transcript.appendLocalEvent("voice", ev.text, "accent");
      } else if (
        ev.type === "task.started" &&
        ev.capabilityId === "coding_agent"
      ) {
        props.transcript.appendLocalEvent(
          "coding",
          `Started: ${ev.label}`,
          "muted",
        );
      } else if (
        ev.type === "task.done" &&
        ev.capabilityId === "coding_agent"
      ) {
        props.transcript.appendLocalEvent(
          "coding",
          `Done: ${ev.summary ?? ev.status}`,
          "success",
        );
      } else if (ev.type === "audio.delta") {
        setVoiceIsPlaying(true);
      } else if (ev.type === "audio.done" || ev.type === "audio.cancelled") {
        setVoiceIsPlaying(false);
      }
    });
    return () => {
      unsub();
    };
  }, [voiceActive, voiceRuntime, props.transcript, voiceInputMode]);

  // Clean up the PTT debounce timer on unmount or when leaving voice mode.
  useEffect(() => {
    if (!voiceActive && pttTimerRef.current) {
      clearTimeout(pttTimerRef.current);
      pttTimerRef.current = null;
      setVoiceIsRecording(false);
    }
    return () => {
      if (pttTimerRef.current) {
        clearTimeout(pttTimerRef.current);
        pttTimerRef.current = null;
      }
    };
  }, [voiceActive]);

  // Dispose voice runtime on TUI unmount (best-effort).
  useEffect(() => {
    return () => {
      const runtime = voiceRuntimeRef.current;
      if (!runtime) return;
      runtime.session.stop().catch(() => {
        // best-effort
      });
      runtime.audioDriver.dispose().catch(() => {
        // best-effort
      });
      voiceRuntimeRef.current = null;
    };
  }, []);
  const availableThemes = useMemo(
    () => mergeTuiThemes(props.themes),
    [props.themes],
  );
  const availableThemeNames = useMemo(
    () => getTuiThemeNames(availableThemes),
    [availableThemes],
  );
  const theme = useMemo(
    () => resolveTuiTheme(availableThemes, themeName).colors,
    [availableThemes, themeName],
  );

  const readComposerSnapshot = (): StepCliTuiComposerState => {
    const editor = composerEditorRef.current;
    if (!editor) {
      return cloneComposerState(composer);
    }

    const value = editor.plainText;
    return {
      value,
      cursorIndex: clampCursorIndex(value, editor.cursorOffset),
    };
  };

  const syncComposerFromEditor = () => {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    if (suppressComposerEditorEventsRef.current) {
      return;
    }

    const nextValue = editor.plainText;
    const nextCursorIndex = clampCursorIndex(nextValue, editor.cursorOffset);
    let contentChanged = false;

    setComposer((current) => {
      contentChanged = current.value !== nextValue;
      const nextComposer = {
        value: nextValue,
        cursorIndex: nextCursorIndex,
      };

      if (
        current.value === nextComposer.value &&
        current.cursorIndex === nextComposer.cursorIndex
      ) {
        return current;
      }

      return nextComposer;
    });

    if (contentChanged) {
      setComposerHistory((current) => detachComposerHistory(current));
    }
  };

  const replaceComposer = (nextComposer: StepCliTuiComposerState) => {
    const normalizedComposer = normalizeComposerState(nextComposer);
    setComposer(normalizedComposer);

    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    suppressComposerEditorEventsRef.current = true;
    editor.setText(normalizedComposer.value);
    editor.cursorOffset = normalizedComposer.cursorIndex;
    if (!pendingApproval) {
      editor.focus();
    }

    queueMicrotask(() => {
      suppressComposerEditorEventsRef.current = false;
    });
  };

  useEffect(() => {
    setThemeName(
      resolveTuiTheme(
        availableThemes,
        props.initialThemeName ?? DEFAULT_TUI_THEME_NAME,
      ).name,
    );
  }, [availableThemes, props.initialThemeName]);

  useEffect(() => {
    void refreshAll("Connecting", "Loading session state");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => props.transcript.subscribe(setTranscriptEntries),
    [props.transcript],
  );

  useEffect(
    () => props.transcript.subscribeQueuedTurns(setQueuedTurns),
    [props.transcript],
  );

  useEffect(
    () => props.transcript.subscribePendingApproval(setPendingApproval),
    [props.transcript],
  );

  useEffect(() => {
    if (!pendingApproval) {
      if (pendingApprovalIdRef.current) {
        setStatus(latestNonApprovalStatusRef.current);
      }
      pendingApprovalIdRef.current = null;
      return;
    }

    pendingApprovalIdRef.current = pendingApproval.id;
    setStatus({
      tone: "warning",
      label: pendingApproval.title,
      detail: `${pendingApproval.toolName} · ${pendingApproval.reason}`,
    });
  }, [pendingApproval]);

  useEffect(() => {
    if (pendingApproval) {
      return;
    }

    latestNonApprovalStatusRef.current = status;
  }, [pendingApproval, status]);

  useEffect(() => {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    if (pendingApproval) {
      editor.blur();
      return;
    }

    editor.focus();
    syncComposerFromEditor();
  }, [columns, pendingApproval]);

  useEffect(() => {
    if (!submitting) {
      setSpinnerFrameIndex(0);
      return;
    }

    const interval = setInterval(() => {
      setSpinnerFrameIndex((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => {
      clearInterval(interval);
    };
  }, [submitting]);

  const slashQuery = useMemo(
    () => resolveSlashCommandQuery(composer.value),
    [composer.value],
  );

  useEffect(() => {
    setSlashSelectionIndex(0);
  }, [slashQuery]);

  const slashPaletteState = useMemo(
    () => buildSlashPaletteState(slashQuery, slashSelectionIndex),
    [slashQuery, slashSelectionIndex],
  );

  const applyComposerEdit = (nextComposer: StepCliTuiComposerState) => {
    setComposerHistory((current) => detachComposerHistory(current));
    replaceComposer(nextComposer);
  };

  const insertComposerNewline = () => {
    const editor = composerEditorRef.current;
    if (editor?.newLine()) {
      return;
    }

    applyComposerEdit(applyComposerPaste(readComposerSnapshot(), "\n"));
  };

  useKeyboard((key) => {
    // Voice mode keyboard layer (intercepts before approval/composer keys).
    // Esc → exit voice (text mode keeps running). Space → PTT toggle hold.
    // T   → swap PTT ↔ duplex. C → cancel current voice task. Ctrl+C is
    // delegated below (it always quits the TUI).
    if (voiceActive && voiceSession) {
      if (key.name === "escape") {
        key.preventDefault();
        if (pttTimerRef.current) {
          clearTimeout(pttTimerRef.current);
          pttTimerRef.current = null;
        }
        // Leave voice mode but keep the WS connection alive: setVoiceActive
        // (false) triggers useAudioPump's cleanup, which flushes the pending
        // audio buffer via session.commitUserAudio() before the pump stops.
        // The session is disposed only on TUI unmount, so /voice can re-enter
        // instantly without re-opening the WebSocket.
        setVoiceActive(false);
        setVoiceIsRecording(false);
        setStatus({
          tone: "accent",
          label: "Voice Off",
          detail: "Switched back to text input (/voice to resume)",
        });
        return;
      }
      const textInput = resolveTextInput(key);
      if (textInput === " ") {
        key.preventDefault();
        if (voiceInputMode === "ptt") {
          // PTT: terminals deliver Space repeatedly while held; debounce on
          // a 200ms idle window to detect the actual key release.
          const now = Date.now();
          pttLastSpaceRef.current = now;
          if (!voiceIsRecording) {
            setVoiceIsRecording(true);
            voiceSession.beginUserAudio();
          }
          if (pttTimerRef.current) clearTimeout(pttTimerRef.current);
          pttTimerRef.current = setTimeout(() => {
            if (Date.now() - pttLastSpaceRef.current >= 200) {
              setVoiceIsRecording(false);
            }
          }, 200);
        }
        return;
      }
      if (textInput?.toLowerCase() === "t") {
        key.preventDefault();
        const nextMode: VoiceInputMode =
          voiceInputMode === "ptt" ? "duplex" : "ptt";
        setVoiceInputMode(nextMode);
        setVoiceIsRecording(false);
        if (nextMode === "duplex") {
          voiceSession.beginUserAudio();
        }
        setStatus({
          tone: "accent",
          label: "Voice",
          detail: `Switched to ${
            nextMode === "ptt" ? "Push-to-Talk" : "Duplex"
          } mode`,
        });
        return;
      }
      if (textInput?.toLowerCase() === "c") {
        key.preventDefault();
        const current = voiceSession.getCurrent();
        if (current) {
          voiceSession.cancelTask(current.taskId);
        }
        setStatus({
          tone: "warning",
          label: "Cancelled",
          detail: "Cancelled current voice response",
        });
        return;
      }
      // All other keys fall through to the default handler so the user can
      // still scroll the transcript / use Ctrl+C to abort the whole TUI.
    }

    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (pendingApproval) {
        props.transcript.cancelPendingApproval();
      }
      if (submitting) {
        for (const controller of abortControllersRef.current) {
          controller.abort();
        }
        setStatus({
          tone: "warning",
          label: "Cancelling",
          detail: "Abort signal sent to active and queued turns",
        });
        return;
      }

      props.onExit();
      return;
    }

    if (pendingApproval) {
      key.preventDefault();

      if (key.name === "escape") {
        props.transcript.cancelPendingApproval();
        setStatus({
          tone: "warning",
          label: "Approval Denied",
          detail: `${pendingApproval.toolName} was denied`,
        });
        return;
      }

      if (key.name === "up") {
        props.transcript.movePendingApprovalSelection(-1);
        return;
      }

      if (key.name === "down") {
        props.transcript.movePendingApprovalSelection(1);
        return;
      }

      if (key.name === "return") {
        props.transcript.submitPendingApprovalSelection();
        return;
      }

      const approvalInput = resolveTextInput(key);
      if (approvalInput) {
        props.transcript.activatePendingApprovalHotkey(approvalInput);
        return;
      }

      return;
    }

    if (key.name === "escape") {
      key.preventDefault();
      props.onExit({
        abortRunning: submitting,
      });
      return;
    }

    if (key.ctrl && key.name === "y") {
      key.preventDefault();
      void handleCopySelectionOrTranscript();
      return;
    }

    if (key.ctrl && key.name === "o") {
      key.preventDefault();
      setToolOutputExpanded((current) => !current);
      return;
    }

    if (key.name === "up") {
      if (slashPaletteState.visible && slashPaletteState.matches.length > 0) {
        key.preventDefault();
        setSlashSelectionIndex((current) => Math.max(0, current - 1));
        return;
      }

      const currentComposer = readComposerSnapshot();
      if (currentComposer.value.includes("\n")) {
        return;
      }

      key.preventDefault();
      const nextState = browseComposerHistory(
        composerHistory,
        currentComposer,
        "older",
      );
      setComposerHistory(nextState.history);
      replaceComposer(nextState.composer);
      return;
    }

    if (key.name === "down") {
      if (slashPaletteState.visible && slashPaletteState.matches.length > 0) {
        key.preventDefault();
        setSlashSelectionIndex((current) =>
          Math.min(slashPaletteState.matches.length - 1, current + 1),
        );
        return;
      }

      const currentComposer = readComposerSnapshot();
      if (currentComposer.value.includes("\n")) {
        return;
      }

      key.preventDefault();
      const nextState = browseComposerHistory(
        composerHistory,
        currentComposer,
        "newer",
      );
      setComposerHistory(nextState.history);
      replaceComposer(nextState.composer);
      return;
    }

    if (key.name === "pageup") {
      key.preventDefault();
      transcriptScrollRef.current?.scrollBy(-transcriptPageScrollStep, "step");
      return;
    }

    if (key.name === "pagedown") {
      key.preventDefault();
      transcriptScrollRef.current?.scrollBy(transcriptPageScrollStep, "step");
      return;
    }

    if (key.name === "home") {
      key.preventDefault();
      transcriptScrollRef.current?.scrollTo(0);
      return;
    }

    if (key.name === "end") {
      key.preventDefault();
      transcriptScrollRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
      return;
    }

    if (isTabKey(key)) {
      key.preventDefault();
      if (slashPaletteState.activeCommand) {
        applyComposerEdit(
          applySlashCommandSelection(
            readComposerSnapshot(),
            slashPaletteState.activeCommand,
          ),
        );
      }
      return;
    }

    if (isComposerNewlineKey(key)) {
      key.preventDefault();
      insertComposerNewline();
      return;
    }

    if (isComposerSubmitKey(key)) {
      key.preventDefault();
      const autocompleteSlashCommand = shouldAutocompleteSlashCommand(
        slashPaletteState,
      )
        ? slashPaletteState.activeCommand
        : null;
      if (autocompleteSlashCommand) {
        applyComposerEdit(
          applySlashCommandSelection(
            readComposerSnapshot(),
            autocompleteSlashCommand,
          ),
        );
        return;
      }

      void handleSubmit();
      return;
    }

    if (key.ctrl && key.name === "a") {
      key.preventDefault();
      const currentComposer = readComposerSnapshot();
      replaceComposer({
        ...currentComposer,
        cursorIndex: 0,
      });
      return;
    }

    if (key.ctrl && key.name === "e") {
      key.preventDefault();
      const currentComposer = readComposerSnapshot();
      replaceComposer({
        ...currentComposer,
        cursorIndex: currentComposer.value.length,
      });
      return;
    }
  });

  const attachmentItems = useMemo(
    () => formatPendingAttachments(pendingAttachments),
    [pendingAttachments],
  );
  const attachmentPreviewItems = useMemo(
    () => attachmentItems.slice(0, MAX_ATTACHMENT_PREVIEW),
    [attachmentItems],
  );
  const summaryText = sessionData?.summary ?? "";
  const transcriptWidth = Math.max(24, columns - 4);
  const composerEditorWidth = Math.max(12, transcriptWidth - 6);
  const composerEditorHeight = useMemo(
    () =>
      resolveComposerEditorHeight(
        composer.value,
        composerEditorWidth,
        terminal.height || 24,
      ),
    [composer.value, composerEditorWidth, terminal.height],
  );
  const transcriptScrollAcceleration = useMemo(
    () => buildTranscriptScrollAcceleration(props.scrollConfig),
    [props.scrollConfig],
  );
  const transcriptPageScrollStep = useMemo(
    () =>
      resolveTranscriptPageScrollStep(
        terminal.height || 24,
        props.scrollConfig,
      ),
    [props.scrollConfig, terminal.height],
  );
  const transcriptItems = useMemo(
    () =>
      buildTranscriptItems(
        transcriptEntries,
        transcriptWidth,
        theme,
        toolOutputExpanded,
      ),
    [theme, transcriptEntries, transcriptWidth, toolOutputExpanded],
  );

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.canvas}
      overflow="hidden"
      onPaste={handlePasteEvent}
    >
      <box flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        <TranscriptPane
          scrollRef={transcriptScrollRef}
          items={transcriptItems}
          scrollAcceleration={transcriptScrollAcceleration}
          summary={summaryText}
          theme={theme}
          width={transcriptWidth}
        />
      </box>
      <ComposerPane
        composerEditorRef={composerEditorRef}
        composerEditorHeight={composerEditorHeight}
        composerEditorWidth={composerEditorWidth}
        onComposerContentChange={syncComposerFromEditor}
        onComposerCursorChange={syncComposerFromEditor}
        pendingApproval={pendingApproval}
        slashPaletteState={slashPaletteState}
        queuedTurns={queuedTurns}
        pendingAttachments={attachmentPreviewItems}
        hiddenAttachmentCount={
          attachmentItems.length - attachmentPreviewItems.length
        }
        status={status}
        textWidth={transcriptWidth}
        submitting={submitting}
        spinnerFrameIndex={spinnerFrameIndex}
        lastRun={lastRun}
        theme={theme}
      />
      {voiceRuntime ? (
        <VoicePane
          voiceUi={voiceRuntime.voiceUi}
          voiceSession={voiceSession}
          voiceDriver={voiceDriverForLayer}
          shouldRecord={voiceShouldRecord}
          mode={voiceInputMode}
          isRecording={voiceShouldRecord}
          isPlaying={voiceIsPlaying}
          visible={voiceActive}
          onToggleMode={() => {
            if (!voiceActive || !voiceSession) return;
            const next = voiceInputMode === "ptt" ? "duplex" : "ptt";
            setVoiceInputMode(next);
            setVoiceIsRecording(false);
            if (next === "duplex") voiceSession.beginUserAudio();
          }}
          onCancel={() => {
            const current = voiceSession?.getCurrent();
            if (current) {
              voiceSession?.cancelTask(current.taskId);
            }
          }}
          onExitVoice={() => {
            // Mirror the ESC keyboard path: leave voice mode but keep the
            // RealtimeSession alive so /voice can resume without re-opening
            // the WebSocket. Disposal happens on TUI unmount.
            setVoiceActive(false);
            setVoiceIsRecording(false);
          }}
        />
      ) : null}
    </box>
  );

  async function handleSubmit(): Promise<void> {
    const composerSnapshot = readComposerSnapshot();
    setComposer(composerSnapshot);
    const inputContent = composerSnapshot.value;
    const inputAttachments = [...pendingAttachments];
    const trimmed = inputContent.trim();
    if (trimmed.length === 0 && inputAttachments.length === 0) {
      setStatus({
        tone: "muted",
        label: "Idle",
        detail: "Type a prompt or queue an attachment first",
      });
      return;
    }

    if (trimmed.startsWith("/")) {
      const clearComposer = await handleSlashCommand(trimmed);
      if (clearComposer) {
        applyComposerEdit({
          value: "",
          cursorIndex: 0,
        });
      }
      return;
    }

    const controller = new AbortController();
    const queued = activeRunCountRef.current > 0;
    const turnInput = {
      content: inputContent,
      ...(inputAttachments.length > 0
        ? { attachments: inputAttachments }
        : undefined),
    };
    abortControllersRef.current.add(controller);
    activeRunCountRef.current += 1;
    setActiveRunCount(activeRunCountRef.current);
    const turnId = props.transcript.submitUserTurn(turnInput, { queued });
    setComposerHistory((current) =>
      rememberSubmittedComposerValue(current, composerSnapshot),
    );
    replaceComposer({
      value: "",
      cursorIndex: 0,
    });
    setPendingAttachments([]);
    setStatus({
      tone: "brand",
      label: queued ? "Queued" : "Running",
      detail: queued
        ? "Waiting for the active turn to finish"
        : "Waiting for the agent turn to finish",
    });

    try {
      const runResult = await props.sdk.runPrompt(
        props.sessionId,
        turnInput,
        controller.signal,
      );
      setLastRun({
        result: runResult.result,
        completedAt: new Date().toISOString(),
      });
      const turnSucceeded = didTurnSucceed(runResult.result);
      const nextStatusDetail = turnSucceeded
        ? summarizeTurn(runResult.result)
        : describeRunFailure(runResult.result);
      const refreshed = await refreshAll(
        turnSucceeded ? "Completed" : "Failed",
        nextStatusDetail,
        turnId,
      );
      if (refreshed) {
        if (!turnSucceeded) {
          props.transcript.appendLocalEvent(
            "error",
            nextStatusDetail,
            "danger",
          );
        }
        setStatus({
          tone: turnSucceeded ? "success" : "danger",
          label: turnSucceeded ? "Completed" : "Failed",
          detail: nextStatusDetail,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const refreshed = await refreshAll("Failed", message, turnId);
      props.transcript.appendLocalEvent("error", message, "danger");
      if (refreshed) {
        setStatus({
          tone: "danger",
          label: "Failed",
          detail: message,
        });
      }
    } finally {
      abortControllersRef.current.delete(controller);
      activeRunCountRef.current = Math.max(0, activeRunCountRef.current - 1);
      setActiveRunCount(activeRunCountRef.current);
      if (activeRunCountRef.current > 0) {
        setStatus({
          tone: "brand",
          label: "Running",
          detail: "Waiting for queued turns to finish",
        });
      }
    }
  }

  async function activateVoiceRuntime(
    cause: "autostart" | "slash",
  ): Promise<void> {
    if (!props.loadVoiceRuntime) {
      props.transcript.appendLocalEvent(
        "voice",
        "voice mode is not configured for this session. Run `step voice` directly, or add `voice.realtime.apiKey` to ~/.step-cli/config.json.",
        "warning",
      );
      return;
    }
    if (voiceLoading) return;
    if (voiceRuntimeRef.current) {
      // Runtime already loaded — just toggle into voice mode.
      setVoiceActive(true);
      if (cause === "slash") {
        setStatus({
          tone: "accent",
          label: "Voice On",
          detail: "Resumed voice mode (Esc to return to text)",
        });
      }
      return;
    }
    setVoiceLoading(true);
    if (cause === "slash") {
      setStatus({
        tone: "accent",
        label: "Voice…",
        detail: "Connecting to realtime backend",
      });
    }
    try {
      const result = await props.loadVoiceRuntime();
      if ("reason" in result) {
        props.transcript.appendLocalEvent(
          "voice",
          `voice unavailable: ${result.reason}`,
          "warning",
        );
        setStatus({
          tone: "warning",
          label: "Voice Unavailable",
          detail: result.reason,
        });
        return;
      }
      voiceRuntimeRef.current = result;
      setVoiceRuntime(result);
      setVoiceActive(true);
      setStatus({
        tone: "accent",
        label: "Voice On",
        detail: `Voice ready (${voiceInputMode}). Esc returns to text.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      props.transcript.appendLocalEvent(
        "voice",
        `voice failed to start: ${message}`,
        "danger",
      );
      setStatus({
        tone: "danger",
        label: "Voice Failed",
        detail: message,
      });
    } finally {
      setVoiceLoading(false);
    }
  }

  async function handleSlashCommand(commandLine: string): Promise<boolean> {
    const [command, ...rest] = commandLine.split(/\s+/);
    switch (command) {
      case "/copy":
        await handleCopySelectionOrTranscript();
        return true;
      case "/help":
        setStatus({
          tone: "accent",
          label: "Help",
          detail: "Showing supported TUI commands",
        });
        return true;
      case "/status":
        setStatus({
          tone: "accent",
          label: "Status",
          detail: sessionData?.snapshot?.clarification?.pending
            ? "Pending clarification exists"
            : formatTuiGoalDetail(
                sessionData?.snapshot?.activeGoal ??
                  sessionData?.snapshot?.runtime?.activeGoal,
              ),
        });
        return true;
      case "/goal":
        return await handleGoalSlashCommand(rest.join(" ").trim());
      case "/refresh":
        if (await refreshAll("Refreshed", "Reloaded session snapshot")) {
          setStatus({
            tone: "success",
            label: "Refreshed",
            detail: "Reloaded session snapshot",
          });
          return true;
        }
        return false;
      case "/theme": {
        const requestedThemeName = rest.join(" ").trim().toLowerCase();
        const availableThemesLabel = formatThemeList(
          themeName,
          availableThemeNames,
        );

        if (!requestedThemeName) {
          setStatus({
            tone: "accent",
            label: "Theme",
            detail: `Current ${themeName}. Available: ${availableThemesLabel}. Use /theme <name> or /theme ${DEFAULT_TUI_THEME_NAME} to recover the default theme.`,
          });
          return true;
        }

        if (!hasTuiTheme(availableThemes, requestedThemeName)) {
          setStatus({
            tone: "warning",
            label: "Theme",
            detail: `Unknown theme "${requestedThemeName}". Available: ${availableThemesLabel}. Use /theme ${DEFAULT_TUI_THEME_NAME} to recover the default theme.`,
          });
          return false;
        }

        if (requestedThemeName === themeName) {
          setStatus({
            tone: "accent",
            label: "Theme",
            detail: `${requestedThemeName} is already active`,
          });
          return true;
        }

        setThemeName(requestedThemeName);

        try {
          await props.onThemeChange?.(requestedThemeName);
          setStatus({
            tone: "success",
            label: "Theme Applied",
            detail: `Switched to ${requestedThemeName}`,
          });
          return true;
        } catch (error) {
          setStatus({
            tone: "warning",
            label: "Theme Applied",
            detail: `Switched to ${requestedThemeName}, but failed to persist: ${error instanceof Error ? error.message : String(error)}`,
          });
          return true;
        }
      }
      case "/resume":
        if (submitting) {
          setStatus({
            tone: "warning",
            label: "Resume",
            detail: "Wait for the active turn to finish before resuming",
          });
          return false;
        }

        {
          const targetSessionId = rest.join(" ").trim();
          if (!targetSessionId) {
            setStatus({
              tone: "warning",
              label: "Resume",
              detail: "Usage: /resume <session_id>",
            });
            return false;
          }

          props.onExit({
            resumeSessionId: targetSessionId,
          });
          return true;
        }
      case "/attach": {
        const rawValue = rest.join(" ").trim();
        if (!rawValue) {
          setStatus({
            tone: "warning",
            label: "Attach",
            detail: "Usage: /attach <path-or-url>",
          });
          return false;
        }

        try {
          const attachment = parseImageAttachmentInput(
            rawValue,
            props.workspaceRoot,
          );
          setPendingAttachments((current) => [...current, attachment]);
          replaceComposer({
            value: "",
            cursorIndex: 0,
          });
          setStatus({
            tone: "success",
            label: "Queued",
            detail: rawValue,
          });
          return true;
        } catch (error) {
          setStatus({
            tone: "danger",
            label: "Attach Failed",
            detail: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      }
      case "/attachments":
        setStatus({
          tone: pendingAttachments.length > 0 ? "accent" : "muted",
          label: "Attachments",
          detail:
            pendingAttachments.length > 0
              ? attachmentItems.map((item) => item.label).join(" | ")
              : "No queued attachments",
        });
        return true;
      case "/detach":
        if (rest.length === 0) {
          setPendingAttachments([]);
          setStatus({
            tone: "success",
            label: "Attachments Cleared",
            detail: "Removed all queued attachments",
          });
          return true;
        }

        {
          const index = Number.parseInt(rest[0] ?? "", 10);
          if (
            !Number.isInteger(index) ||
            index < 1 ||
            index > pendingAttachments.length
          ) {
            setStatus({
              tone: "warning",
              label: "Detach",
              detail: "Usage: /detach [index]",
            });
            return false;
          }

          setPendingAttachments((current) =>
            current.filter((_, currentIndex) => currentIndex !== index - 1),
          );
          setStatus({
            tone: "success",
            label: "Attachment Removed",
            detail: `Removed item ${index}`,
          });
          return true;
        }
      case "/exit":
        props.onExit({
          abortRunning: submitting,
        });
        return true;
      case "/voice": {
        await activateVoiceRuntime("slash");
        return true;
      }
      default:
        setStatus({
          tone: "warning",
          label: "Unknown Command",
          detail: `${command} is not supported in the OpenTUI client`,
        });
        return false;
    }
  }

  async function handleGoalSlashCommand(args: string): Promise<boolean> {
    if (!args) {
      setStatus({
        tone: "warning",
        label: "Goal",
        detail: "Usage: /goal <text|status|pause|resume|stop>",
      });
      return false;
    }

    const [subcommand, ...rest] = args.split(/\s+/);
    try {
      if (subcommand === "status") {
        const result = await props.sdk.getGoalStatus(props.sessionId);
        setStatus({
          tone: result?.goal ? "accent" : "muted",
          label: "Goal",
          detail: formatTuiGoalDetail(result?.goal ?? null),
        });
        return true;
      }

      if (subcommand === "pause") {
        const reason = rest.join(" ").trim();
        const result = await props.sdk.pauseGoal(
          props.sessionId,
          reason ? { reason } : {},
        );
        await refreshAll("Goal", formatTuiGoalDetail(result.goal));
        setStatus({
          tone: "success",
          label: "Goal",
          detail: formatTuiGoalDetail(result.goal),
        });
        return true;
      }

      if (subcommand === "resume") {
        const reason = rest.join(" ").trim();
        const result = await props.sdk.resumeGoal(
          props.sessionId,
          reason ? { reason } : {},
        );
        await refreshAll("Goal", formatTuiGoalDetail(result.goal));
        setStatus({
          tone: "success",
          label: "Goal",
          detail: formatTuiGoalDetail(result.goal),
        });
        return true;
      }

      if (subcommand === "stop") {
        const reason = rest.join(" ").trim();
        const result = await props.sdk.stopGoal(
          props.sessionId,
          reason ? { reason } : {},
        );
        await refreshAll("Goal", formatTuiGoalDetail(result.goal));
        setStatus({
          tone: "success",
          label: "Goal",
          detail: formatTuiGoalDetail(result.goal),
        });
        return true;
      }

      const result = await props.sdk.startGoal(props.sessionId, { text: args });
      await refreshAll("Goal", formatTuiGoalDetail(result.goal));
      setStatus({
        tone: "success",
        label: "Goal",
        detail: formatTuiGoalDetail(result.goal),
      });
      replaceComposer({
        value: "",
        cursorIndex: 0,
      });
      return true;
    } catch (error) {
      setStatus({
        tone: "danger",
        label: "Goal Failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async function handleCopySelectionOrTranscript(): Promise<void> {
    const selectedText = readSelectedText(renderer);
    if (selectedText) {
      await handleCopySelection(selectedText);
      return;
    }

    const transcriptText = buildTranscriptClipboardText(transcriptEntries);
    if (transcriptText.length === 0) {
      setStatus({
        tone: "warning",
        label: "Copy",
        detail: "No transcript content to copy yet",
      });
      return;
    }

    try {
      await copyTextToClipboard(transcriptText);
      setStatus({
        tone: "success",
        label: "Copied",
        detail: `Copied ${transcriptEntries.length} transcript ${transcriptEntries.length === 1 ? "entry" : "entries"} to the clipboard`,
      });
    } catch (error) {
      setStatus({
        tone: "danger",
        label: "Copy Failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleCopySelection(selectedText: string): Promise<void> {
    try {
      await copyTextToClipboard(selectedText);
      renderer.clearSelection();
      setStatus({
        tone: "success",
        label: "Copied",
        detail: "Copied selected transcript text to the clipboard",
      });
    } catch (error) {
      setStatus({
        tone: "danger",
        label: "Copy Failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function refreshAll(
    label: string,
    detail: string,
    settledTurnId?: string,
  ): Promise<boolean> {
    setStatus({
      tone: "brand",
      label,
      detail,
    });
    try {
      const nextSessionData = await loadTuiSessionData(
        props.sdk,
        props.sessionId,
      );
      props.transcript.reconcileWithSessionMessages(
        nextSessionData.messages,
        settledTurnId,
      );
      setSessionData(nextSessionData);
      if (label === "Connecting") {
        setStatus({
          tone: "brand",
          label: "Ready",
          detail: "Type a prompt or /help",
        });
      }
      return true;
    } catch (error) {
      setStatus({
        tone: "danger",
        label: "Load Failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function handlePasteEvent(event: PasteEvent): void {
    if (pendingApproval) {
      event.preventDefault();
      return;
    }

    const pastedText = decodePasteBytes(event.bytes);
    if (!pastedText) {
      return;
    }

    event.preventDefault();
    applyComposerEdit(applyComposerPaste(readComposerSnapshot(), pastedText));
  }
}

const TranscriptPane = React.memo(function TranscriptPane(input: {
  scrollRef: React.RefObject<ScrollBoxRenderable>;
  items: TranscriptItem[];
  scrollAcceleration: ScrollAcceleration;
  summary: string;
  theme: StepCliTuiThemeColors;
  width: number;
}) {
  const allSummaryLines = input.summary.length
    ? wrapMultiline(input.summary, Math.max(12, input.width - 4))
    : [];
  const summaryLines = allSummaryLines.slice(0, 4);

  return (
    <scrollbox
      ref={input.scrollRef}
      width="100%"
      height="100%"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflow="hidden"
      scrollY
      scrollAcceleration={input.scrollAcceleration}
      stickyScroll
      stickyStart="bottom"
      contentOptions={{
        flexDirection: "column",
      }}
      paddingX={1}
      paddingTop={1}
      paddingBottom={1}
      scrollbarOptions={{
        showArrows: true,
        trackOptions: {
          foregroundColor: input.theme.brand,
          backgroundColor: input.theme.line,
        },
      }}
    >
      {summaryLines.length > 0 ? (
        <box flexDirection="column" marginBottom={1}>
          <text fg={input.theme.foreground}>
            <span bg={input.theme.systemBadge} fg={input.theme.warning}>
              {" "}
              SUMMARY{" "}
            </span>
            <span fg={input.theme.foreground}> {summaryLines[0] ?? ""}</span>
          </text>
          {summaryLines.slice(1).map((line, index) => (
            <text key={`summary:${index}`} fg={input.theme.foreground}>
              <span fg={input.theme.line}>│ </span>
              {line.length > 0 ? line : " "}
            </text>
          ))}
          {allSummaryLines.length > summaryLines.length ? (
            <text fg={input.theme.muted}>
              <span fg={input.theme.line}>│ </span>…
            </text>
          ) : null}
        </box>
      ) : null}
      <box flexDirection="column">
        {input.items.map((item) => (
          <TranscriptEntry key={item.id} item={item} theme={input.theme} />
        ))}
      </box>
    </scrollbox>
  );
});

const TranscriptEntry = React.memo(function TranscriptEntry(input: {
  item: TranscriptItem;
  theme: StepCliTuiThemeColors;
}) {
  const { item } = input;
  const [firstLine = "", ...restLines] =
    item.lines.length > 0 ? item.lines : [""];
  const badgeStyle = resolveTranscriptBadgeStyle(item.tone, input.theme);
  const isCollapsed = item.collapsible && !item.expanded;
  const body = (
    <>
      <text fg={input.theme.foreground}>
        <span bg={badgeStyle.backgroundColor} fg={badgeStyle.textColor}>
          {" "}
          {item.badge}{" "}
        </span>
        {item.caption && !isCollapsed ? (
          <span fg={input.theme.muted}> {item.caption}</span>
        ) : null}
        {firstLine.length > 0 ? <span> {firstLine}</span> : null}
      </text>
      {isCollapsed
        ? restLines.map((line, index) => (
            <text key={`${item.id}:${index}`} fg={input.theme.muted}>
              {line.length > 0 ? line : " "}
            </text>
          ))
        : restLines.map((line, index) => (
            <text key={`${item.id}:${index}`} fg={input.theme.foreground}>
              <span fg={badgeStyle.railColor}>│ </span>
              {line.length > 0 ? line : " "}
            </text>
          ))}
      {item.truncated ? (
        <text fg={input.theme.muted}>
          <span fg={badgeStyle.railColor}>│ </span>…
        </text>
      ) : null}
    </>
  );

  return (
    <box flexDirection="column" marginBottom={1}>
      {item.backgroundColor !== null || item.border ? (
        <box
          flexDirection="column"
          backgroundColor={item.backgroundColor ?? undefined}
          border={item.border ? true : false}
          borderColor={item.border ? input.theme.line : undefined}
          paddingX={1}
          paddingTop={1}
          paddingBottom={1}
        >
          {body}
        </box>
      ) : (
        body
      )}
    </box>
  );
});

function VoicePane(input: {
  voiceUi: VoiceRuntimeBundle["voiceUi"];
  voiceSession: RealtimeSession | null;
  voiceDriver: AudioDriver | null;
  shouldRecord: boolean;
  mode: VoiceInputMode;
  isRecording: boolean;
  isPlaying: boolean;
  visible: boolean;
  onToggleMode: () => void;
  onCancel: () => void;
  onExitVoice: () => void;
}) {
  const { voiceUi } = input;
  // Hooks must run unconditionally regardless of visibility, so they keep a
  // stable position in render order even when the user toggles voice off.
  voiceUi.useAudioPump(
    input.voiceSession,
    input.voiceDriver,
    input.shouldRecord,
  );
  voiceUi.usePlayback(input.voiceSession, input.voiceDriver);
  if (!input.visible) return null;
  const Widget = voiceUi.Widget;
  return (
    <Widget
      mode={input.mode}
      isRecording={input.isRecording}
      isPlaying={input.isPlaying}
      onToggleMode={input.onToggleMode}
      onCancel={input.onCancel}
      onExitVoice={input.onExitVoice}
    />
  );
}

function ComposerPane(input: {
  composerEditorRef: React.RefObject<TextareaRenderable>;
  composerEditorHeight: number;
  composerEditorWidth: number;
  onComposerContentChange: () => void;
  onComposerCursorChange: () => void;
  pendingApproval: StepCliTuiPendingApproval | null;
  slashPaletteState: SlashPaletteState;
  queuedTurns: StepCliTuiQueuedTurnEntry[];
  pendingAttachments: StepCliTuiPendingAttachment[];
  hiddenAttachmentCount: number;
  status: StepCliTuiStatus;
  textWidth: number;
  submitting: boolean;
  spinnerFrameIndex: number;
  lastRun: StepCliTuiLastRunState | null;
  theme: StepCliTuiThemeColors;
}) {
  const composerBackground = input.pendingApproval
    ? input.theme.panelAlt
    : input.theme.inputBackground;
  const statusDetail = truncateInline(
    input.status.detail.replace(/\s+/g, " ").trim(),
    Math.max(18, input.textWidth - visibleLength(input.status.label) - 8),
  );
  const spinnerText = input.submitting
    ? `${SPINNER_FRAMES[input.spinnerFrameIndex] ?? SPINNER_FRAMES[0]} `
    : "";

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border={["top"]}
      borderColor={input.theme.line}
      backgroundColor={input.theme.panel}
      paddingX={1}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={toneToColor(input.status.tone, input.theme)} marginBottom={1}>
        {spinnerText}
        {input.status.label}
        {statusDetail.length > 0 ? (
          <span fg={input.theme.muted}> · {statusDetail}</span>
        ) : null}
      </text>
      {input.queuedTurns.length > 0 ? (
        <QueuedTurnBuffer
          queuedTurns={input.queuedTurns}
          textWidth={input.textWidth}
          theme={input.theme}
        />
      ) : null}
      {input.pendingApproval ? (
        <ApprovalInlineCard
          pendingApproval={input.pendingApproval}
          textWidth={input.textWidth}
          theme={input.theme}
        />
      ) : null}
      <box
        flexDirection="column"
        backgroundColor={composerBackground}
        paddingX={1}
        paddingTop={1}
        paddingBottom={1}
      >
        <box flexDirection="row">
          <text fg={input.theme.brand}>{"> "}</text>
          <box flexGrow={1} minWidth={0}>
            <textarea
              ref={input.composerEditorRef}
              width={input.composerEditorWidth}
              height={input.composerEditorHeight}
              focused={!input.pendingApproval}
              showCursor={!input.pendingApproval}
              wrapMode="char"
              backgroundColor={composerBackground}
              focusedBackgroundColor={composerBackground}
              textColor={input.theme.foreground}
              focusedTextColor={input.theme.foreground}
              placeholder="Type a prompt or /help"
              placeholderColor={input.theme.muted}
              selectionBg={input.theme.selection}
              selectionFg={input.theme.foreground}
              cursorStyle={{
                style: "line",
                blinking: true,
              }}
              onContentChange={input.onComposerContentChange}
              onCursorChange={input.onComposerCursorChange}
            />
          </box>
        </box>
      </box>
      {input.slashPaletteState.visible && !input.pendingApproval ? (
        <SlashCommandPalette
          slashPaletteState={input.slashPaletteState}
          textWidth={input.textWidth}
          theme={input.theme}
        />
      ) : null}
      {input.pendingAttachments.length > 0 ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={input.theme.warning}>attachments</text>
          {input.pendingAttachments.map((item, index) => (
            <text key={`${item.label}:${index}`} fg={input.theme.foreground}>
              {index + 1}. {truncatePath(item.label, 80)}
            </text>
          ))}
          {input.hiddenAttachmentCount > 0 ? (
            <text fg={input.theme.muted}>
              +{input.hiddenAttachmentCount} more
            </text>
          ) : null}
        </box>
      ) : null}
      {input.lastRun ? (
        <text fg={input.theme.muted} marginTop={1}>
          last turn: {summarizeTurn(input.lastRun.result)}
        </text>
      ) : null}
      <text fg={input.theme.muted} marginTop={1}>
        {input.pendingApproval
          ? "Approval pending · a/s/d shortcuts · ↑/↓ move · Enter confirm · Esc deny"
          : "Enter submit · Shift+Enter/Ctrl+J newline · Ctrl+Y or /copy copy selection/full transcript · Esc quit"}
      </text>
    </box>
  );
}

function ApprovalInlineCard(input: {
  pendingApproval: StepCliTuiPendingApproval;
  textWidth: number;
  theme: StepCliTuiThemeColors;
}) {
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={input.theme.panelAlt}
      border={["left"]}
      borderColor={input.theme.line}
    >
      <text fg={input.theme.foreground}>
        <span bg={input.theme.systemBadge} fg={input.theme.foreground}>
          {" "}
          APPROVAL{" "}
        </span>
        <span fg={input.theme.foreground}> {input.pendingApproval.title}</span>
      </text>
      {input.pendingApproval.options.map((option, index) => {
        const selected = index === input.pendingApproval.selectedIndex;
        const label = `[${option.hotkey}] ${option.label}`;

        return (
          <text key={option.value} fg={input.theme.foreground}>
            <span fg={selected ? input.theme.accent : input.theme.line}>
              {selected ? "› " : "  "}
            </span>
            <span
              bg={selected ? input.theme.selection : undefined}
              fg={input.theme.foreground}
            >
              {truncateInline(label, Math.max(18, input.textWidth - 4))}
            </span>
          </text>
        );
      })}
    </box>
  );
}

function QueuedTurnBuffer(input: {
  queuedTurns: StepCliTuiQueuedTurnEntry[];
  textWidth: number;
  theme: StepCliTuiThemeColors;
}) {
  const visibleQueuedTurns = input.queuedTurns.slice(
    0,
    MAX_QUEUED_TURN_PREVIEW,
  );
  const hiddenQueuedTurnCount = Math.max(
    0,
    input.queuedTurns.length - visibleQueuedTurns.length,
  );

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      paddingBottom={1}
      border={["bottom"]}
      borderColor={input.theme.line}
    >
      <text fg={input.theme.accent}>queue</text>
      {visibleQueuedTurns.map((entry, index) => {
        const lines = buildQueuedTurnPreviewLines(
          entry.input,
          Math.max(12, input.textWidth - 6),
        );
        const [firstLine = "", ...restLines] =
          lines.length > 0 ? lines : ["(empty prompt)"];

        return (
          <box key={entry.id} flexDirection="column">
            <text fg={input.theme.foreground}>
              <span fg={input.theme.line}>{index + 1}. </span>
              {firstLine}
            </text>
            {restLines.map((line, lineIndex) => (
              <text key={`${entry.id}:${lineIndex}`} fg={input.theme.muted}>
                <span fg={input.theme.line}>{"   "}</span>
                {line}
              </text>
            ))}
          </box>
        );
      })}
      {hiddenQueuedTurnCount > 0 ? (
        <text fg={input.theme.muted}>+{hiddenQueuedTurnCount} more</text>
      ) : null}
    </box>
  );
}

function SlashCommandPalette(input: {
  slashPaletteState: SlashPaletteState;
  textWidth: number;
  theme: StepCliTuiThemeColors;
}) {
  const commandWindow = resolveSlashPaletteWindow(
    input.slashPaletteState.matches,
    input.slashPaletteState.selectedIndex,
    MAX_SLASH_COMMAND_ITEMS,
  );
  const commands = commandWindow.items;

  return (
    <box
      flexDirection="column"
      marginTop={1}
      paddingTop={1}
      border={["top"]}
      borderColor={input.theme.line}
    >
      <text fg={input.theme.accent}>commands</text>
      {commands.length === 0 ? (
        <text fg={input.theme.muted}> No matching commands</text>
      ) : (
        <>
          {commandWindow.hasOverflowAbove ? (
            <text fg={input.theme.muted}>
              {`  ... ${commandWindow.startIndex} earlier`}
            </text>
          ) : null}
          {commands.map((command, index) => {
            const matchIndex = commandWindow.startIndex + index;
            const selected =
              matchIndex === input.slashPaletteState.selectedIndex;
            const label = command.argHint
              ? `${command.command} ${command.argHint}`
              : command.command;
            const description = truncateInline(
              command.description,
              Math.max(18, input.textWidth - visibleLength(label) - 8),
            );

            return (
              <text key={command.command} fg={input.theme.foreground}>
                <span fg={selected ? input.theme.accent : input.theme.line}>
                  {selected ? "› " : "  "}
                </span>
                <span
                  fg={selected ? input.theme.brand : input.theme.foreground}
                >
                  {label}
                </span>
                <span fg={input.theme.muted}> · {description}</span>
              </text>
            );
          })}
          {commandWindow.hasOverflowBelow ? (
            <text fg={input.theme.muted}>
              {`  ... ${input.slashPaletteState.matches.length - commandWindow.endIndex} more`}
            </text>
          ) : null}
        </>
      )}
      <text fg={input.theme.muted}>
        {commandWindow.hasOverflowAbove || commandWindow.hasOverflowBelow
          ? ` Tab complete · Enter run · ${commandWindow.startIndex + 1}-${commandWindow.endIndex} / ${input.slashPaletteState.matches.length}`
          : " Tab complete · Enter run"}
      </text>
    </box>
  );
}

function buildTranscriptItems(
  entries: StepCliTuiTranscriptEntry[],
  width: number,
  theme: StepCliTuiThemeColors,
  toolOutputExpanded: boolean,
): TranscriptItem[] {
  return [
    buildWelcomeTranscriptItem(width),
    ...entries
      .filter((entry) => !entry.hidden)
      .map((entry, index) => {
        const identity = resolveTranscriptIdentity(entry);
        const isTool = entry.role === "tool";
        const isReasoning = entry.role === "reasoning";
        const collapsible = isTool || isReasoning;
        const contentWidth = Math.max(12, width - 4);
        // Collapsible lines must go through wrapMultiline like every other
        // transcript line: OpenTUI <text> does not wrap by itself and scroll
        // heights are computed from wrapped line counts.
        const lines = collapsible
          ? (isTool
              ? buildToolTranscriptLines(entry, toolOutputExpanded)
              : buildReasoningTranscriptLines(entry, toolOutputExpanded)
            ).flatMap((line) => wrapMultiline(line, contentWidth))
          : wrapMultiline(compactToolTranscriptContent(entry), contentWidth);
        return {
          id:
            entry.id ||
            `message:${index}:${identity.badge}:${identity.caption ?? ""}`,
          ...identity,
          backgroundColor: resolveTranscriptBackground(entry, theme),
          border: false,
          lines,
          truncated: false,
          collapsible,
          expanded: collapsible ? toolOutputExpanded : undefined,
        };
      }),
  ];
}

function buildWelcomeTranscriptItem(width: number): TranscriptItem {
  const welcomeLines = [
    "Welcome to STEP.",
    "Start with a prompt, or use /attach to queue an image.",
    "Enter send · Shift+Enter newline · Ctrl+Y or /copy copy selection/full transcript · Ctrl+O expand/collapse tool & reasoning output · Esc quit",
    "/goal /attach /copy /detach /status /refresh /theme [name] /resume <session_id> /exit",
  ].flatMap((line) => wrapMultiline(line, Math.max(12, width - 4)));

  return {
    id: "welcome",
    badge: "STEP",
    caption: "welcome",
    tone: "brand",
    lines: welcomeLines,
    truncated: false,
    backgroundColor: null,
    border: true,
  };
}

function buildQueuedTurnPreviewLines(
  input: StepCliTuiQueuedTurnEntry["input"],
  width: number,
): string[] {
  const prompt = input.content.trim();
  const lines = [
    prompt.length > 0 ? prompt : "(attachments only)",
    ...(input.attachments && input.attachments.length > 0
      ? [`[attachments] ${input.attachments.length}`]
      : []),
  ].flatMap((line) => wrapMultiline(line, width));

  if (lines.length <= MAX_QUEUED_TURN_LINES) {
    return lines;
  }

  return [
    ...lines.slice(0, MAX_QUEUED_TURN_LINES - 1),
    truncateInline(
      lines[MAX_QUEUED_TURN_LINES - 1] ?? "",
      Math.max(4, width - 1),
    ) + "…",
  ];
}

function toneToColor(
  tone: StepCliTuiTone,
  theme: StepCliTuiThemeColors,
): string {
  switch (tone) {
    case "muted":
      return theme.muted;
    case "accent":
      return theme.accent;
    case "brand":
      return theme.brand;
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "danger":
      return theme.danger;
  }
}

function resolveSlashCommandQuery(value: string): string | null {
  const normalized = value.trimStart();
  if (!normalized.startsWith("/")) {
    return null;
  }

  const firstLine = normalized.split("\n")[0] ?? "";
  const token = firstLine.split(/\s+/, 1)[0] ?? "";
  return token.slice(1).toLowerCase();
}

function buildSlashPaletteState(
  query: string | null,
  selectionIndex: number,
): SlashPaletteState {
  if (query === null) {
    return {
      visible: false,
      query: null,
      matches: [],
      selectedIndex: 0,
      activeCommand: null,
      hasExactMatch: false,
    };
  }

  const matches = SLASH_COMMAND_DEFINITIONS.filter((command) =>
    query.length === 0
      ? true
      : command.command.slice(1).toLowerCase().startsWith(query),
  );
  const selectedIndex =
    matches.length === 0
      ? 0
      : Math.max(0, Math.min(selectionIndex, matches.length - 1));
  const activeCommand = matches[selectedIndex] ?? null;
  const hasExactMatch = SLASH_COMMAND_DEFINITIONS.some(
    (command) => command.command.slice(1).toLowerCase() === query,
  );

  return {
    visible: true,
    query,
    matches,
    selectedIndex,
    activeCommand,
    hasExactMatch,
  };
}

function shouldAutocompleteSlashCommand(
  slashPaletteState: SlashPaletteState,
): boolean {
  return (
    slashPaletteState.visible &&
    slashPaletteState.activeCommand !== null &&
    !slashPaletteState.hasExactMatch
  );
}

function applySlashCommandSelection(
  composer: StepCliTuiComposerState,
  command: SlashCommandDefinition,
): StepCliTuiComposerState {
  return {
    value: command.insertText,
    cursorIndex: command.insertText.length,
  };
}

function resolveTranscriptIdentity(
  entry: StepCliTuiTranscriptEntry,
): Pick<TranscriptItem, "badge" | "caption" | "tone"> {
  switch (entry.role) {
    case "assistant":
      return {
        badge: "STEP",
        caption: entry.caption,
        tone: "brand",
      };
    case "user":
      return {
        badge: "YOU",
        caption: entry.caption,
        tone: "accent",
      };
    case "tool":
      return {
        badge: "TOOL",
        caption: entry.caption,
        tone: "success",
      };
    case "reasoning":
      return {
        badge: "THINK",
        caption: entry.caption,
        tone: "muted",
      };
    case "system":
      return {
        badge: "SYSTEM",
        caption: entry.caption,
        tone: "muted",
      };
  }
}

function resolveTranscriptBackground(
  entry: StepCliTuiTranscriptEntry,
  theme: StepCliTuiThemeColors,
): string | null {
  return entry.role === "user" ? theme.inputBackground : null;
}

function resolveTranscriptBadgeStyle(
  tone: StepCliTuiTone,
  theme: StepCliTuiThemeColors,
): {
  backgroundColor: string;
  textColor: string;
  railColor: string;
} {
  switch (tone) {
    case "accent":
      return {
        backgroundColor: theme.userBadge,
        textColor: theme.accent,
        railColor: theme.accent,
      };
    case "brand":
      return {
        backgroundColor: theme.assistantBadge,
        textColor: theme.brand,
        railColor: theme.brand,
      };
    case "success":
      return {
        backgroundColor: theme.toolBadge,
        textColor: theme.success,
        railColor: theme.success,
      };
    case "warning":
      return {
        backgroundColor: theme.systemBadge,
        textColor: theme.warning,
        railColor: theme.warning,
      };
    case "danger":
      return {
        backgroundColor: theme.systemBadge,
        textColor: theme.danger,
        railColor: theme.danger,
      };
    case "muted":
      return {
        backgroundColor: theme.systemBadge,
        textColor: theme.muted,
        railColor: theme.line,
      };
  }
}

function formatThemeList(
  currentThemeName: StepCliTuiThemeName,
  themeNames: readonly string[],
): string {
  return themeNames
    .map((name) => (name === currentThemeName ? `${name}*` : name))
    .join(", ");
}

function resolveComposerEditorHeight(
  text: string,
  width: number,
  terminalHeight: number,
): number {
  const contentHeight = Math.max(1, wrapMultiline(text, width).length);
  return Math.min(
    contentHeight,
    resolveComposerEditorMaxHeight(terminalHeight),
  );
}

function resolveComposerEditorMaxHeight(terminalHeight: number): number {
  return Math.max(
    MIN_COMPOSER_EDITOR_MAX_HEIGHT,
    Math.min(
      MAX_COMPOSER_EDITOR_MAX_HEIGHT,
      Math.floor(
        Math.max(terminalHeight, 1) * COMPOSER_EDITOR_MAX_HEIGHT_RATIO,
      ),
    ),
  );
}

function wrapMultiline(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }

    let remaining = rawLine;
    while (visibleLength(remaining) > width) {
      const line = sliceByDisplayWidth(remaining, width);
      lines.push(line);
      remaining = remaining.slice(line.length);
    }
    lines.push(remaining);
  }

  return lines;
}

function truncateInline(value: string, maxWidth: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (visibleLength(singleLine) <= maxWidth) {
    return singleLine;
  }

  return `${sliceByDisplayWidth(singleLine, Math.max(1, maxWidth - 1))}…`;
}

function sliceByDisplayWidth(value: string, width: number): string {
  if (visibleLength(value) <= width) {
    return value;
  }

  let end = 0;
  for (const symbol of value) {
    if (visibleLength(value.slice(0, end + symbol.length)) > width) {
      break;
    }
    end += symbol.length;
  }

  return value.slice(0, Math.max(1, end));
}

function truncatePath(value: string, maxWidth: number): string {
  if (visibleLength(value) <= maxWidth) {
    return value;
  }

  const normalized = value.replace(`${path.sep}${path.sep}`, path.sep);
  const base = path.basename(normalized);
  if (visibleLength(base) + 4 >= maxWidth) {
    return `.../${base}`.slice(0, maxWidth);
  }

  const available = Math.max(1, maxWidth - visibleLength(base) - 4);
  const prefix = normalized.slice(0, available);
  return `${prefix}.../${base}`;
}

function isTabKey(key: KeyEvent): boolean {
  return key.name === "tab" || key.sequence === "\t" || key.raw === "\t";
}

function resolveTextInput(key: KeyEvent): string | null {
  if (key.ctrl || key.meta || key.option) {
    return null;
  }

  if (
    key.name === "return" ||
    key.name === "escape" ||
    key.name === "tab" ||
    key.name === "backspace" ||
    key.name === "delete" ||
    key.name === "up" ||
    key.name === "down" ||
    key.name === "left" ||
    key.name === "right"
  ) {
    return null;
  }

  const candidate = key.sequence || key.raw;
  if (!candidate || containsAsciiControlCharacter(candidate)) {
    return null;
  }

  return candidate;
}

function containsAsciiControlCharacter(input: string): boolean {
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }

  return false;
}

function clampCursorIndex(value: string, cursorIndex: number): number {
  return Math.max(0, Math.min(value.length, cursorIndex));
}

function normalizeComposerState(
  composer: StepCliTuiComposerState,
): StepCliTuiComposerState {
  return {
    value: composer.value,
    cursorIndex: clampCursorIndex(composer.value, composer.cursorIndex),
  };
}

function cloneComposerState(
  composer: StepCliTuiComposerState,
): StepCliTuiComposerState {
  return normalizeComposerState(composer);
}

interface TranscriptItem {
  id: string;
  badge: string;
  caption: string | null;
  tone: StepCliTuiTone;
  backgroundColor: string | null;
  border: boolean;
  lines: string[];
  truncated: boolean;
  /** When true, the entry can be expanded/collapsed with Ctrl+O. */
  collapsible?: boolean;
  /** Current expansion state (only meaningful when collapsible is true). */
  expanded?: boolean;
}

interface SlashPaletteState {
  visible: boolean;
  query: string | null;
  matches: readonly SlashCommandDefinition[];
  selectedIndex: number;
  activeCommand: SlashCommandDefinition | null;
  hasExactMatch: boolean;
}
