import os from "node:os";
import { spawn } from "node:child_process";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Text, useApp, useStdout } from "ink";
import { writeHost, type ScreenWriter } from "./screenWriter.js";
import { ClientConnection } from "./connection.js";
import { TerminalPane } from "./TerminalPane.js";
import { DragPreview, type DragPreviewState } from "./DragPreview.js";
import type { MouseInputEvent } from "./mouse.js";
import {
  inkStyle,
  paneKeyBytes,
  useTerminalInput,
  APPEARANCE_QUERY,
  type InkStyleKey,
  type InputToken,
  type KeyPress,
} from "./input.js";
import {
  COMPACT_SIDEBAR_WIDTH,
  computeLayout,
  contentCell,
  framePanes,
  NO_EDGES,
  paneAt,
  paneContentRect,
  paneFrames,
  screenLayout,
  splitAt,
  type PaneChrome,
  type PaneStyle,
} from "./geometry.js";
import {
  LOCAL_MACHINE_ID,
  agentSummarySegments,
  sidebarRows,
  tabBarRow,
  targetAt,
  type ChromeRow,
  type ClickTarget,
  type Segment,
} from "./chrome.js";
import { ChromeLine, Sidebar } from "./Sidebar.js";
import {
  mobileHeaderRows,
  revealScroll,
  switcherDocument,
  switcherScreen,
  switcherViewport,
} from "./mobile.js";
import { useTabBarStatus } from "./tabBarStatus.js";
import {
  firstPaneItem,
  navigatorItems,
  NavigatorOverlay,
  nextPaneItem,
  type NavigatorItem,
  type NavigatorState,
  type StatusFilter,
} from "./navigator.js";
import {
  SETTINGS_TABS,
  SettingsOverlay,
  settingsOptions,
  type SettingsOption,
  type SettingsState,
} from "./settings.js";
import { writeConfigValue } from "../config/write.js";
import type { ShepherdConfig } from "../config/model.js";
import {
  centeredRect,
  menuRect,
  MenuOverlay,
  Panel,
  type MenuItem,
  type MenuState,
} from "./panels.js";
import { workspaceLabel as workspaceLabelOf } from "./chrome.js";
import {
  applySurfaceFrame,
  isShellLike,
  viewTop,
  selectionText,
  wordAt,
  type PaneSurface,
  type TextSelection,
} from "./surfaces.js";
import { copyToClipboard } from "./clipboard.js";
import path from "node:path";
import {
  decideNotification,
  playSound,
  systemNotification,
  terminalNotification,
  terminalNotifyBackend,
} from "./notifications.js";
import { paneIds as paneIdsOf } from "../server/layout.js";
import { ToastStack, type ToastEntry } from "./overlays.js";
import { comboKey, type Action } from "../config/keybinds.js";
import { defaultLoadedConfig, loadConfig, type LoadedConfig } from "../config/model.js";
import { HelpOverlay, ConfirmOverlay } from "./overlays.js";
import {
  editText,
  fieldParts,
  insertText,
  textField,
  type TextField,
} from "./textEditor.js";
import {
  copyMotionForKey,
  moveCopyCursor,
  type CopyPosition,
} from "./copyMode.js";
import { applyTheme, theme } from "./theme.js";
import { useAgentPulse } from "./useAgentPulse.js";
import type {
  AgentStatus,
  EventFrame,
  StateView,
  SurfaceFrame,
  TerminalLine,
} from "../types.js";

export interface AppConnection {
  request: ClientConnection["request"];
  close: () => void;
  setEventHandler?: ClientConnection["setEventHandler"];
}

export type Mode = "terminal" | "prefix" | "navigate" | "resize" | "copy";

const NO_STRIP = { ctrl: false, alt: false };

/** The global menu, shared by its popup and the phone-width switcher. */
const GLOBAL_MENU: Array<{ label: string; action: Action }> = [
  { label: "toggle agent grouping", action: "toggle_agent_sort" },
  { label: "settings", action: "settings" },
  { label: "keybinds", action: "help" },
  { label: "reload config", action: "reload_config" },
  { label: "detach", action: "detach" },
];

export function App({
  connection,
  copyText = copyToClipboard,
  config: initialConfig = defaultLoadedConfig(),
  reloadConfig = () => loadConfig(),
}: {
  connection: AppConnection;
  /** Clipboard writer; tests substitute their own. */
  copyText?: typeof copyToClipboard;
  config?: LoadedConfig;
  reloadConfig?: () => LoadedConfig;
}) {
  const [loadedConfig, setLoadedConfig] = useState(initialConfig);
  const { config, keymap } = loadedConfig;
  const [appearance, setAppearance] = useState<"dark" | "light" | null>(null);
  const appearanceExplicit = useRef(false);
  // Apply the theme during render so children read the new colours.
  const themeDiagnostics = useMemo(() => {
    const { theme: themeConfig } = config;
    if (!themeConfig.auto_switch) {
      return applyTheme(themeConfig.name, themeConfig.custom, config.ui.accent);
    }
    const light = appearance === "light";
    return applyTheme(
      light ? themeConfig.light_name || "shepherd-day" : themeConfig.dark_name || themeConfig.name,
      { ...themeConfig.custom, ...(light ? themeConfig.custom_light : themeConfig.custom_dark) },
      config.ui.accent,
    );
  }, [appearance, config]);
  const [mode, setMode] = useState<Mode>("terminal");
  const [navigateIndex, setNavigateIndex] = useState(0);
  /** Scroll offset of the phone-width switcher's list. */
  const [mobileScroll, setMobileScroll] = useState(0);
  const prefix = mode === "prefix";
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpFilter, setHelpFilter] = useState("");
  const [navigator, setNavigator] = useState<NavigatorState | null>(null);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  /** Session-modal popup terminal opened by this client. */
  const [popup, setPopup] = useState<{
    paneId: string;
    width: string;
    height: string;
    title: string;
  } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** Workspace, tab or pane a rename prompt applies to (null = active). */
  const renameTarget = useRef<string | null>(null);
  /** Panes whose right clicks go to the app instead of the pane menu. */
  const [rightClickPanes, setRightClickPanes] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(config.ui.sidebar_start_collapsed);
  const [sidebarWidth, setSidebarWidth] = useState(config.ui.sidebar_width);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  /** Machines ("local" or IDs) collapsed in the machines sidebar. */
  const [collapsedMachines, setCollapsedMachines] = useState<Set<string>>(() => new Set());
  /** Remote workspace shown in the remote dashboard; null shows every
   * remote pane. */
  const [remoteScope, setRemoteScope] = useState<
    { machineId: string; workspaceId: string } | null
  >(null);
  const [agentSort, setAgentSort] = useState<"spaces" | "status">(config.ui.agent_panel_sort);
  const [agentScroll, setAgentScroll] = useState<number>();
  const sidebarDrag = useRef(false);
  /** Tab or workspace being dragged to a new position. */
  const reorderDrag = useRef<{
    kind: "tab" | "workspace";
    id: string;
    moved: boolean;
  } | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const lastFocus = useRef<{ current: string; previous: string | null }>({
    current: "",
    previous: null,
  });
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<StateView | null>(null);
  const [surfaces, setSurfaces] = useState<Record<string, PaneSurface>>({});
  const [renameMode, setRenameMode] = useState<
    "pane" | "tab" | "workspace" | "new-tab" | "new-workspace" | "new-worktree" | null
  >(null);
  const [renameField, setRenameField] = useState<TextField>(() => textField());
  const renameDraft = renameField.value;
  const setRenameDraft = (value: string) => setRenameField(textField(value));
  const [pluginPickerOpen, setPluginPickerOpen] = useState(false);
  const [selectedPluginAction, setSelectedPluginAction] = useState(0);
  const [pluginResult, setPluginResult] = useState<string | null>(null);
  const [remoteMode, setRemoteMode] = useState<"picker" | "read" | "prompt" | null>(null);
  const [selectedRemoteAgent, setSelectedRemoteAgent] = useState(0);
  const [remotePrompt, setRemotePrompt] = useState("");
  const [remoteOutput, setRemoteOutput] = useState("");
  const [remotePaneMode, setRemotePaneMode] = useState<
    "picker" | "view" | "input" | null
  >(null);
  const [remoteDashboardOpen, setRemoteDashboardOpen] = useState(false);
  const [selectedRemotePane, setSelectedRemotePane] = useState(0);
  const [remotePaneOutput, setRemotePaneOutput] = useState("");
  const [remotePaneTiles, setRemotePaneTiles] = useState<
    Record<string, TerminalLine[]>
  >({});
  const [remotePaneInput, setRemotePaneInput] = useState("");
  const remotePaneRefreshInFlight = useRef(false);
  const remoteDashboardRefreshInFlight = useRef(false);
  const [message, setMessageText] = useState("");
  const messageTimer = useRef<NodeJS.Timeout | null>(null);
  /** Brief status line shown in the mode-bar slot. */
  const setMessage = useCallback((text: string) => {
    setMessageText(text);
    if (messageTimer.current) clearTimeout(messageTimer.current);
    if (text) {
      messageTimer.current = setTimeout(() => setMessageText(""), 3_000);
      messageTimer.current.unref?.();
    }
  }, []);
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const [subscriptionEpoch, setSubscriptionEpoch] = useState(0);
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const notificationTarget = useRef<string | null>(null);
  const notifyRef = useRef<((notice: Notice) => void) | null>(null);
  const agentEventRef = useRef<((data: Record<string, unknown>) => void) | null>(null);
  const stateRef = useRef<StateView | null>(null);
  const [copyState, setCopyState] = useState<{
    paneId: string;
    cursor: CopyPosition;
    anchor: CopyPosition | null;
    lineMode: boolean;
    search: { query: string; direction: "forward" | "backward" } | null;
  } | null>(null);
  const [searchPrompt, setSearchPrompt] = useState<{
    direction: "forward" | "backward";
    text: string;
  } | null>(null);
  const hostFocused = useRef(true);
  const splitDrag = useRef<{
    paneId: string;
    direction: "right" | "down";
    last: number;
    span: number;
  } | null>(null);
  const paneDrag = useRef<{
    paneId: string;
    x: number;
    y: number;
  } | null>(null);
  const selectionDrag = useRef<{ paneId: string; moved: boolean } | null>(null);
  const lastClick = useRef<{ at: number; paneId: string; col: number; row: number } | null>(null);
  const appMouseDrag = useRef<string | null>(null);
  /** Modifiers removed from the app mouse gesture in progress. */
  const appMouseStrip = useRef(NO_STRIP);
  const [terminalSelection, setTerminalSelection] = useState<TextSelection | null>(null);
  const [screenSize, setScreenSize] = useState({
    columns: stdout.columns ?? 120,
    rows: stdout.rows ?? 40,
  });
  useEffect(() => {
    const onResize = () => setScreenSize({
      columns: stdout.columns ?? 120,
      rows: stdout.rows ?? 40,
    });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  const setHostCursor = useCallback(
    (cursor: Parameters<ScreenWriter["setCursor"]>[0]) => {
      (stdout as unknown as Partial<ScreenWriter>).setCursor?.(cursor);
    },
    [stdout],
  );

  const activeTabCount = state?.workspaces.find((workspace) =>
    workspace.id === state.activeWorkspaceId
  )?.tabs.length ?? 1;
  const screen = useMemo(
    () => screenLayout(screenSize.columns, screenSize.rows, {
      sidebarWidth,
      sidebarState: sidebarCollapsed ? config.ui.sidebar_collapsed_mode : "expanded",
      tabBar: config.ui.hide_tab_bar_when_single_tab && activeTabCount <= 1
        ? "none"
        : config.ui.tab_bar_position,
      mobileThreshold: config.ui.mobile_width_threshold,
    }),
    [activeTabCount, config.ui, screenSize, sidebarCollapsed, sidebarWidth],
  );
  const { columns, rows } = screen;
  const mainWidth = screen.main.width;
  const mainHeight = screen.main.height;

  const popupRect = useMemo(() => popup
    ? centeredRect(
      screen.columns,
      screen.rows,
      popupSize(popup.width, screen.columns),
      popupSize(popup.height, screen.rows),
    )
    : null, [popup, screen.columns, screen.rows]);

  const activeWorkspace = state?.workspaces.find(
    (workspace) => workspace.id === state?.activeWorkspaceId,
  );
  const activeTab = activeWorkspace?.tabs.find(
    (tab) => tab.id === state?.activeTabId,
  );
  const effectiveLayout = useMemo(() => {
    if (!activeTab?.zoomedPaneId) return activeTab?.layout ?? null;
    return { kind: "pane" as const, paneId: activeTab.zoomedPaneId };
  }, [activeTab]);
  const layout = useMemo(
    () => computeLayout(effectiveLayout, screen.main),
    [effectiveLayout, screen.main],
  );
  const tabPaneCount = activeTab ? paneIdsOf(activeTab.layout).length : 1;
  const paneStyle = useMemo((): PaneStyle => ({
    borders: config.ui.pane_borders,
    gaps: config.ui.pane_gaps,
    outerBorders: config.ui.pane_outer_borders,
  }), [config.ui.pane_borders, config.ui.pane_gaps, config.ui.pane_outer_borders]);
  // Pane rects after the pane style: rendering, PTY sizes and mouse
  // hit-testing all use these.
  const geometries = useMemo(
    () => framePanes(layout.panes, paneStyle, tabPaneCount),
    [layout.panes, paneStyle, tabPaneCount],
  );
  const paneOrder = geometries.map((entry) => entry.paneId);
  const focusedPaneForFrames = state?.focusedPaneId ?? null;
  const frames = useMemo(
    () => paneFrames(geometries, layout.splits, paneStyle, focusedPaneForFrames),
    [focusedPaneForFrames, geometries, layout.splits, paneStyle],
  );
  const chromeFor = useCallback((paneId: string): PaneChrome => ({
    bordered: false,
    edges: geometries.find((entry) => entry.paneId === paneId)?.edges ?? NO_EDGES,
    scrollbar: config.ui.pane_scrollbars &&
      !surfaces[paneId]?.modes?.alternateScreen,
  }), [config.ui, geometries, surfaces]);

  const refreshState = useCallback(async () => {
    if (refreshInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    refreshInFlight.current = true;
    try {
      do {
        refreshQueued.current = false;
        const nextState = (await connection.request({
          type: "state.get",
        })) as StateView;
        setState(nextState);
      } while (refreshQueued.current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      refreshInFlight.current = false;
    }
  }, [connection]);

  useEffect(() => {
    const pendingFrames: SurfaceFrame[] = [];
    let frameFlush: NodeJS.Immediate | null = null;
    connection.setEventHandler?.((event: EventFrame) => {
      if (event.event === "pane.surface") {
        pendingFrames.push(event.data as unknown as SurfaceFrame);
        frameFlush ??= setImmediate(() => {
          frameFlush = null;
          const frames = pendingFrames.splice(0);
          setSurfaces((current) => {
            const next = { ...current };
            for (const frame of frames) {
              next[frame.paneId] = applySurfaceFrame(next[frame.paneId], frame);
            }
            return next;
          });
        });
        return;
      }
      if (event.event === "state.changed") {
        void refreshState();
        return;
      }
      if (event.event === "popup.opened") {
        // Plugin popups are opened by the daemon on this client's behalf.
        const data = event.data as {
          paneId?: string;
          clientId?: string;
          pluginId?: string;
          title?: string;
          width?: string;
          height?: string;
        };
        if (
          data.pluginId &&
          data.paneId &&
          data.clientId &&
          data.clientId === stateRef.current?.clientId
        ) {
          setPopup({
            paneId: data.paneId,
            width: data.width ?? "50%",
            height: data.height ?? "50%",
            title: data.title ?? data.pluginId,
          });
        }
        return;
      }
      if (event.event === "client.window_title") {
        setTitleOverride(typeof event.data.title === "string" ? event.data.title : null);
        return;
      }
      if (event.event === "popup.closed") {
        const paneId = event.data.paneId;
        setPopup((current) => current?.paneId === paneId ? null : current);
        return;
      }
      if (event.event === "connection.lost") {
        setMessage("daemon connection lost · reconnecting…");
        return;
      }
      if (event.event === "connection.restored") {
        setMessage("reconnected");
        void connection.request({ type: "events.subscribe" });
        setSubscriptionEpoch((epoch) => epoch + 1);
        void refreshState();
        return;
      }
      if (event.event === "pane.clipboard") {
        const text = typeof event.data.text === "string" ? event.data.text : "";
        void copyText(text, (data) => writeHost(stdout, data)).catch(() => {});
        return;
      }
      if (event.event === "pane.bell") {
        writeHost(stdout, "\u0007");
        return;
      }
      if (event.event === "notification.show") {
        const title = typeof event.data.title === "string" ? event.data.title : "";
        const body = typeof event.data.body === "string" ? event.data.body : "";
        notifyRef.current?.({
          title,
          context: body,
          paneId: null,
          sound: event.data.sound === "done" || event.data.sound === "request"
            ? event.data.sound
            : null,
        });
        return;
      }
      if (event.event !== "agent.status.changed") return;
      void refreshState();
      agentEventRef.current?.(event.data);
    });
    void connection.request({ type: "events.subscribe" });
    void refreshState();
    // Titles and agent status also change without a state event.
    const timer = setInterval(() => void refreshState(), 1_000);
    return () => {
      clearInterval(timer);
      if (frameFlush) clearImmediate(frameFlush);
      connection.setEventHandler?.(undefined);
    };
  }, [connection, copyText, refreshState, stdout]);

  // The outer terminal's title follows the active workspace, like Shepherd's
  // default "{hostname}: {workspace}".
  const focusedPaneView = state?.panes.find((pane) => pane.id === state.focusedPaneId);
  const windowTitle = titleOverride ?? (activeWorkspace
    ? renderWindowTitle(config.ui.window_title, {
      hostname: os.hostname().split(".")[0] ?? "",
      workspace: activeWorkspace.name,
      tab: activeTab?.name ?? "",
      pane: focusedPaneView?.title ?? "",
      terminal_title: state ? surfaces[state.focusedPaneId]?.title ?? "" : "",
    })
    : "");
  useEffect(() => {
    if (windowTitle) writeHost(stdout, `\x1b]2;${windowTitle}\x07`);
  }, [stdout, windowTitle]);

  useEffect(() => setAgentScroll(undefined), [state?.focusedPaneId, agentSort]);
  const sidebarModel = useMemo(() => state
    ? sidebarRows(state, {
      width: screen.sidebar.width,
      height: screen.sidebar.height,
      focusedPaneId: state.focusedPaneId,
      activeWorkspaceId: state.activeWorkspaceId,
      indicators: config.ui.status_indicators,
      sort: agentSort,
      agentScroll,
      mouse: config.ui.mouse_capture,
      navigateWorkspaceId: mode === "navigate"
        ? state.workspaces[navigateIndex]?.id ?? null
        : null,
      compact: screen.sidebar.width > 0 && screen.sidebar.width <= COMPACT_SIDEBAR_WIDTH,
      collapsedGroups,
      collapsedMachines,
      selectedRemote: remoteDashboardOpen ? remoteScope : null,
      sidebar: config.ui.sidebar,
    })
    : [], [
      agentSort,
      agentScroll,
      collapsedGroups,
      collapsedMachines,
      config.ui,
      mode,
      navigateIndex,
      remoteDashboardOpen,
      remoteScope,
      screen.sidebar,
      state,
    ]);
  const tabBarStatus = useTabBarStatus(
    config.ui.tab_bar_right,
    config.ui.tab_bar_right_separator,
    Boolean(activeTab?.zoomedPaneId),
  );
  const agentPulse = useAgentPulse(state);
  const tabBarModel = useMemo(() => state && activeWorkspace && screen.tabBar
    ? tabBarRow(activeWorkspace.tabs, {
      width: screen.tabBar.width,
      activeTabId: state.activeTabId,
      zoomedTabIds: new Set(activeWorkspace.tabs
        .filter((tab) => tab.zoomedPaneId)
        .map((tab) => tab.id)),
      mouse: config.ui.mouse_capture,
      right: [
        ...agentSummarySegments(state, agentPulse),
        { text: " ", backgroundColor: theme.panelBg },
        ...tabBarStatus,
        { text: " ", backgroundColor: theme.panelBg },
      ],
    })
    : null, [activeWorkspace, agentPulse, config.ui.mouse_capture, screen.tabBar, state, tabBarStatus]);

  // Phone width: a status header over the panes, and in navigate mode a
  // full-screen switcher in place of the sidebar and tab bar.
  const mobileHeader = useMemo(() => state && screen.header
    ? mobileHeaderRows(state, {
      width: screen.header.width,
      height: screen.header.height,
      indicators: config.ui.status_indicators,
    })
    : [], [config.ui.status_indicators, screen.header, state]);
  const switcherOpen = screen.mobile && mode === "navigate";
  const switcherDoc = useMemo(() => state && switcherOpen
    ? switcherDocument(state, {
      width: screen.columns - 1,
      indicators: config.ui.status_indicators,
      sort: agentSort,
      navigateWorkspaceId: state.workspaces[navigateIndex]?.id ?? null,
      menu: GLOBAL_MENU.map((entry) => entry.label),
    })
    : null, [agentSort, config.ui.status_indicators, navigateIndex, screen.columns, state, switcherOpen]);
  const switcher = useMemo(() => switcherDoc
    ? switcherScreen(switcherDoc, {
      width: screen.columns,
      height: screen.rows,
      scroll: mobileScroll,
    })
    : null, [mobileScroll, screen.columns, screen.rows, switcherDoc]);
  // Keyboard navigation keeps the highlighted workspace in view.
  const navigatedWorkspaceId = switcherOpen ? state?.workspaces[navigateIndex]?.id : undefined;
  useEffect(() => {
    if (!navigatedWorkspaceId || !switcherDoc) return;
    setMobileScroll((scroll) => revealScroll(
      switcherDoc.workspaceRows.get(navigatedWorkspaceId),
      scroll,
      switcherViewport(screen.rows),
    ));
    // Only on a highlight change, so the wheel can scroll away from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigatedWorkspaceId]);

  // Tell the daemon which panes are on screen and at what size; it resizes
  // them and pushes their surfaces.
  const surfaceInterest = useMemo(() => JSON.stringify([
    ...geometries.map((entry) => {
      const content = paneContentRect(entry.rect, chromeFor(entry.paneId));
      return { paneId: entry.paneId, cols: content.width, rows: content.height };
    }),
    ...(popup && popupRect
      ? [{
        paneId: popup.paneId,
        cols: Math.max(1, popupRect.width - 2),
        rows: Math.max(1, popupRect.height - 2),
      }]
      : []),
  ]), [chromeFor, geometries, popup, popupRect]);
  useEffect(() => {
    void connection.request({
      type: "surface.subscribe",
      panes: JSON.parse(surfaceInterest),
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [connection, surfaceInterest, subscriptionEpoch]);

  useEffect(() => {
    const focused = state?.focusedPaneId;
    if (focused && focused !== lastFocus.current.current) {
      lastFocus.current = {
        current: focused,
        previous: lastFocus.current.current || null,
      };
    }
  }, [state?.focusedPaneId]);

  stateRef.current = state;

  const pushToast = useCallback((toast: Omit<ToastEntry, "id">, ttl = 6_000) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((current) => [...current.slice(-3), { ...toast, id }]);
    setTimeout(() => {
      setToasts((current) => current.filter((entry) => entry.id !== id));
    }, ttl);
  }, []);

  /** Delivers a notification through the configured channel. */
  notifyRef.current = (notice: Notice) => {
    const soundConfig = config.ui.sound;
    const agentSound = notice.agent ? soundConfig.agents[notice.agent] : undefined;
    if (
      notice.sound &&
      soundConfig.enabled &&
      agentSound !== "off" &&
      !process.env.SHEPHERD_DISABLE_SOUND
    ) {
      const file = (notice.sound === "done" ? soundConfig.done_path : soundConfig.request_path) ||
        soundConfig.path;
      playSound(
        file ? path.resolve(path.dirname(loadedConfig.path || "."), file) : null,
        () => writeHost(stdout, "\u0007"),
      );
    }
    if (notice.paneId) notificationTarget.current = notice.paneId;
    const delivery = config.ui.toast.delivery;
    if (delivery === "off" || !notice.title) return;
    if (delivery === "system") {
      systemNotification(notice.title, notice.context);
      return;
    }
    if (delivery === "terminal") {
      const sequence = terminalNotification(
        terminalNotifyBackend(),
        notice.title,
        notice.context,
      );
      if (sequence) {
        writeHost(stdout, sequence);
        return;
      }
    }
    pushToast({
      title: notice.title,
      context: notice.context,
      tone: notice.sound === "request" ? "attention" : "done",
      position: config.ui.toast.position,
    });
  };

  const lastAgentStatus = useRef(new Map<string, AgentStatus>());
  agentEventRef.current = (data) => {
    const paneId = typeof data.paneId === "string" ? data.paneId : "";
    const status = data.status as AgentStatus;
    const previous = (data.previous as AgentStatus | undefined) ??
      lastAgentStatus.current.get(paneId);
    lastAgentStatus.current.set(paneId, status);
    const agent = typeof data.agent === "string" ? data.agent : "agent";
    const deliver = () => {
      const current = stateRef.current;
      const pane = current?.panes.find((entry) => entry.id === paneId);
      if (!current || !pane || pane.status !== status) return;
      const visible = paneOrder.includes(paneId);
      const suppressed = visible && hostFocused.current;
      const decision = decideNotification(previous, status, suppressed);
      if (!decision.toast && !decision.sound) return;
      const workspaceIndex = current.workspaces.findIndex((workspace) =>
        workspace.tabs.some((tab) => paneIdsOf(tab.layout).includes(paneId))
      );
      const workspace = current.workspaces[workspaceIndex];
      const tab = workspace?.tabs.find((entry) => paneIdsOf(entry.layout).includes(paneId));
      const context = workspace
        ? `${workspace.name} · ${workspaceIndex + 1}${
          workspace.tabs.length > 1 && tab ? ` · ${tab.name}` : ""
        }`
        : "";
      notifyRef.current?.({
        title: decision.toast ? `${agent} ${decision.toast}` : "",
        context,
        paneId,
        agent,
        sound: decision.sound,
      });
    };
    setTimeout(deliver, config.ui.toast.delay_seconds * 1_000);
  };

  // Invalid config values fall back to defaults; say so, like Shepherd's
  // startup warning banner.
  useEffect(() => {
    const warnings = [...loadedConfig.diagnostics, ...themeDiagnostics];
    if (warnings.length > 0) {
      setMessage(`config: ${warnings.length} warning(s) · ${warnings[0]}`);
    }
  }, [loadedConfig, themeDiagnostics]);

  // Place the host terminal's cursor on the focused pane's cursor.
  const focusedGeometry = geometries.find((entry) =>
    entry.paneId === state?.focusedPaneId
  );
  const focusedSurface = state ? surfaces[state.focusedPaneId] : undefined;
  const overlayOpen = Boolean(
    pluginPickerOpen || renameMode || remoteMode || remotePaneMode ||
      remoteDashboardOpen || helpOpen || confirm || navigator || menu || popup ||
      settings,
  );
  const popupSurface = popup ? surfaces[popup.paneId] : undefined;
  useEffect(() => {
    if (popup) {
      const cursor = popupSurface?.cursor;
      if (!popupRect || !cursor?.visible) {
        setHostCursor(null);
        return;
      }
      setHostCursor({
        x: popupRect.x + 1 + cursor.x,
        y: popupRect.y + 1 + cursor.y,
        shape: cursor.shape,
        blink: cursor.blink,
      });
      return;
    }
    const cursor = focusedSurface?.cursor;
    if (!focusedGeometry || !cursor?.visible || overlayOpen || mode !== "terminal") {
      setHostCursor(null);
      return;
    }
    const content = paneContentRect(focusedGeometry.rect, chromeFor(focusedGeometry.paneId));
    if (cursor.x >= content.width || cursor.y >= content.height) {
      setHostCursor(null);
      return;
    }
    setHostCursor({
      x: content.x + cursor.x,
      y: content.y + cursor.y,
      shape: cursor.shape,
      blink: cursor.blink,
    });
  }, [
    chromeFor,
    focusedGeometry,
    focusedSurface,
    mode,
    overlayOpen,
    popup,
    popupRect,
    popupSurface,
    setHostCursor,
  ]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, successMessage = "ready") => {
      try {
        await action();
        setMessage(successMessage);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [],
  );

  const focusOffset = useCallback(
    (offset: number) => {
      if (!state) return;
      const currentIndex = paneOrder.indexOf(state.focusedPaneId);
      const nextIndex =
        currentIndex === -1
          ? 0
          : (currentIndex + offset + paneOrder.length) % paneOrder.length;
      const paneId = paneOrder[nextIndex];
      if (paneId) {
        void runAction(
          () => connection.request({ type: "pane.focus", paneId }),
          `focused ${paneId}`,
        );
      }
    },
    [connection, paneOrder, runAction, state],
  );

  const selectTab = useCallback(
    (index: number) => {
      if (!state) return;
      const tab = state.tabs[index];
      if (!tab) return;
      void runAction(
        () => connection.request({ type: "tab.select", tabId: tab.id }),
        `tab ${tab.name}`,
      );
    },
    [connection, runAction, state],
  );

  const selectWorkspaceOffset = useCallback(
    (offset: number) => {
      if (!state) return;
      const currentIndex = state.workspaces.findIndex(
        (workspace) => workspace.id === state.activeWorkspaceId,
      );
      const nextIndex = currentIndex === -1
        ? 0
        : (currentIndex + offset + state.workspaces.length) % state.workspaces.length;
      const workspace = state.workspaces[nextIndex];
      if (!workspace) return;
      void runAction(
        () => connection.request({
          type: "workspace.select",
          workspaceId: workspace.id,
        }),
        `workspace ${workspace.name}`,
      );
    },
    [connection, runAction, state],
  );

  const submitRename = useCallback(async () => {
    if (!state || !renameMode) return;
    const value = renameDraft.trim();
    if (
      !value && renameMode !== "new-tab" && renameMode !== "new-workspace"
    ) {
      setRenameMode(null);
      return;
    }

    try {
      if (renameMode === "new-worktree") {
        await connection.request({
          type: "worktree.create",
          workspaceId: renameTarget.current ?? state.activeWorkspaceId,
          branch: value,
        }, 60_000);
      } else if (renameMode === "new-tab") {
        await connection.request({
          type: "tab.create",
          ...(value ? { name: value } : {}),
        });
      } else if (renameMode === "new-workspace") {
        await connection.request({
          type: "workspace.create",
          ...(value ? { name: value } : {}),
        });
      } else if (renameMode === "pane") {
        await connection.request({
          type: "pane.rename",
          paneId: renameTarget.current ?? state.focusedPaneId,
          title: value,
        });
      } else if (renameMode === "tab") {
        await connection.request({
          type: "tab.rename",
          tabId: renameTarget.current ?? state.activeTabId,
          name: value,
        });
      } else {
        await connection.request({
          type: "workspace.rename",
          workspaceId: renameTarget.current ?? state.activeWorkspaceId,
          name: value,
        });
      }
      setMessage(renameMode === "new-tab" ? "tab created" : renameMode === "new-workspace" ? "workspace created" : `${renameMode} renamed`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRenameMode(null);
      setRenameDraft("");
      renameTarget.current = null;
    }
  }, [connection, renameDraft, renameMode, setMessage, state]);

  const pluginActions = useMemo(() => (state?.plugins ?? [])
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.actions.map((action) => ({
      pluginId: plugin.id,
      actionId: action.id,
      label: `${plugin.id}.${action.id}`,
      title: action.title,
      command: action.command.join(" "),
    }))), [state]);

  const invokeSelectedPluginAction = useCallback(async () => {
    const action = pluginActions[selectedPluginAction];
    if (!action) return;
    try {
      const result = await connection.request({
        type: "plugin.action-invoke",
        pluginId: action.pluginId,
        actionId: action.actionId,
      }, 35_000) as {
        exitCode: number | null;
        stdout: string;
        stderr: string;
      };
      const output = result.exitCode === 0
        ? result.stdout.trim() || "plugin action completed"
        : result.stderr.trim() ||
          `plugin action exited ${result.exitCode ?? "without status"}`;
      setPluginResult(output);
      setMessage(`${action.label} completed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPluginResult(message);
      setMessage(message);
    } finally {
      setPluginPickerOpen(false);
    }
  }, [connection, pluginActions, selectedPluginAction]);

  const refreshMachines = useCallback(async () => {
    if (!state || state.machines.length === 0) {
      setMessage("no saved machines");
      return;
    }
    try {
      const results = await Promise.all(state.machines.map((machine) =>
        connection.request({
          type: "machine.refresh",
          labelOrId: machine.label,
        }, 15_000)
      ));
      const reachable = results.filter((result) =>
        (result as { reachable?: boolean }).reachable === true
      ).length;
      setMessage(`${reachable}/${state.machines.length} machines reachable`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [connection, state]);

  const remoteAgents = useMemo(() => (state?.machines ?? [])
    .filter((machine) => machine.reachable && machine.remote)
    .flatMap((machine) => machine.remote?.agents.map((agent) => ({
      machineId: machine.id,
      machineLabel: machine.label,
      paneId: agent.paneId,
      agent: agent.agent,
      status: agent.status,
      title: agent.title,
    })) ?? []), [state]);

  const remotePanes = useMemo(() => (state?.machines ?? [])
    .filter((machine) => machine.reachable && machine.remote)
    .flatMap((machine) => machine.remote?.panes.map((pane) => ({
      machineId: machine.id,
      machineLabel: machine.label,
      paneId: pane.paneId,
      title: pane.title,
      agent: pane.agent,
      status: pane.status,
    })) ?? []), [state]);

  /** Panes the remote dashboard shows: one remote workspace when opened
   * from the machines sidebar, otherwise every reachable remote pane. */
  const dashboardPanes = useMemo(() => {
    if (!remoteScope) return remotePanes;
    const machine = state?.machines.find((entry) => entry.id === remoteScope.machineId);
    const workspace = machine?.remote?.workspaceList?.find((entry) =>
      entry.id === remoteScope.workspaceId
    );
    if (!workspace) return [];
    const ids = new Set(workspace.tabs.flatMap((tab) => paneIdsOf(tab.layout)));
    return remotePanes.filter((pane) =>
      pane.machineId === remoteScope.machineId && ids.has(pane.paneId)
    );
  }, [remotePanes, remoteScope, state]);

  const dashboardTitle = useMemo(() => {
    if (!remoteScope) return "streaming remote panes";
    const machine = state?.machines.find((entry) => entry.id === remoteScope.machineId);
    const workspace = machine?.remote?.workspaceList?.find((entry) =>
      entry.id === remoteScope.workspaceId
    );
    const name = workspace ? workspaceLabelOf(workspace) : remoteScope.workspaceId;
    const stale = machine && machine.status !== "online" ? ` · ${machine.status}` : "";
    return `${machine?.label ?? remoteScope.machineId} · ${name}${stale}`;
  }, [remoteScope, state]);

  /** Shows a remote workspace's panes, connecting its machine if needed. */
  const openRemoteWorkspace = useCallback((machineId: string, workspaceId: string) => {
    const machine = state?.machines.find((entry) => entry.id === machineId);
    if (!machine) return;
    if (machine.status !== "online") {
      setMessage(`${machine.label}: ${machine.status}${machine.error ? ` · ${machine.error}` : ""}`);
      void connection.request({ type: "machine.refresh", labelOrId: machine.id }, 60_000)
        .catch(() => {});
    }
    setRemoteScope({ machineId, workspaceId });
    setRemoteDashboardOpen(true);
  }, [connection, state]);

  const readRemoteAgent = useCallback(async () => {
    const agent = remoteAgents[selectedRemoteAgent];
    if (!agent) return;
    try {
      const result = await connection.request({
        type: "machine.agent-read",
        labelOrId: agent.machineLabel,
        target: agent.paneId,
        rows: 80,
        source: "recent-unwrapped",
      }, 35_000) as { value: string };
      setRemoteOutput(result.value || "(no remote output)");
      setRemoteMode("read");
      setMessage(`${agent.agent}@${agent.machineLabel} read`);
    } catch (error) {
      setRemoteOutput(error instanceof Error ? error.message : String(error));
      setRemoteMode("read");
    }
  }, [connection, remoteAgents, selectedRemoteAgent]);

  const sendRemotePrompt = useCallback(async () => {
    const agent = remoteAgents[selectedRemoteAgent];
    if (!agent || !remotePrompt.trim()) {
      setRemoteMode("read");
      return;
    }
    try {
      const result = await connection.request({
        type: "machine.agent-prompt",
        labelOrId: agent.machineLabel,
        target: agent.paneId,
        prompt: remotePrompt,
        timeoutMs: 120_000,
      }, 135_000) as { value: string };
      setRemoteOutput(result.value || "remote prompt submitted");
      setMessage(`prompted ${agent.agent}@${agent.machineLabel}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRemoteOutput(message);
      setMessage(message);
    } finally {
      setRemotePrompt("");
      setRemoteMode("read");
    }
  }, [connection, remoteAgents, remotePrompt, selectedRemoteAgent]);

  const readRemotePane = useCallback(async (options?: { silent?: boolean }) => {
    const pane = remotePanes[selectedRemotePane];
    if (!pane) return;
    if (remotePaneRefreshInFlight.current) return;
    remotePaneRefreshInFlight.current = true;
    try {
      const result = await connection.request({
        type: "machine.pane-read",
        labelOrId: pane.machineLabel,
        paneId: pane.paneId,
        rows: 80,
        source: "recent-unwrapped",
      }, 35_000) as { value: string };
      setRemotePaneOutput(result.value || "(no remote pane output)");
      setRemotePaneMode("view");
      if (!options?.silent) {
        setMessage(`${pane.title}@${pane.machineLabel} surface read`);
      }
    } catch (error) {
      setRemotePaneOutput(error instanceof Error ? error.message : String(error));
      setRemotePaneMode("view");
    } finally {
      remotePaneRefreshInFlight.current = false;
    }
  }, [connection, remotePanes, selectedRemotePane]);

  useEffect(() => {
    if (remotePaneMode !== "view") return;
    let cancelled = false;
    const refresh = async () => {
      if (!cancelled) await readRemotePane({ silent: true });
    };
    const timer = setInterval(() => void refresh(), 750);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [readRemotePane, remotePaneMode]);

  const sendRemotePaneInput = useCallback(async () => {
    const pane = remotePanes[selectedRemotePane];
    if (!pane || !remotePaneInput.trim()) {
      setRemotePaneMode("view");
      return;
    }
    try {
      await connection.request({
        type: "machine.pane-input",
        labelOrId: pane.machineLabel,
        paneId: pane.paneId,
        data: remotePaneInput,
      }, 25_000);
      setRemotePaneInput("");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await readRemotePane();
      setMessage(`sent input to ${pane.title}@${pane.machineLabel}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [connection, readRemotePane, remotePaneInput, remotePanes, selectedRemotePane]);

  const refreshRemoteDashboard = useCallback(async () => {
    if (remoteDashboardRefreshInFlight.current) return;
    remoteDashboardRefreshInFlight.current = true;
    try {
      const nextTiles: Record<string, TerminalLine[]> = {};
      await Promise.all(dashboardPanes.map(async (pane) => {
        const result = await connection.request({
          type: "machine.pane-read",
          labelOrId: pane.machineLabel,
          paneId: pane.paneId,
          rows: 20,
          source: "recent-unwrapped",
        }, 20_000) as { value: string };
        nextTiles[`${pane.machineId}:${pane.paneId}`] = result.value
          .split("\n")
          .slice(-16)
          .map((line) => [{ text: line.length ? line : " " }]);
      }));
      setRemotePaneTiles(nextTiles);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      remoteDashboardRefreshInFlight.current = false;
    }
  }, [connection, dashboardPanes]);

  useEffect(() => {
    if (!remoteDashboardOpen) return;
    void refreshRemoteDashboard();
    const timer = setInterval(() => void refreshRemoteDashboard(), 750);
    return () => clearInterval(timer);
  }, [refreshRemoteDashboard, remoteDashboardOpen]);

  const copySelection = useCallback((selection: TextSelection) => {
    const first = Math.min(selection.anchor.row, selection.head.row);
    const last = Math.max(selection.anchor.row, selection.head.row);
    void (async () => {
      const fetched = await connection.request({
        type: "pane.text",
        paneId: selection.paneId,
        start: first,
        count: last - first + 1,
      }) as { start: number; lines: string[] } | undefined;
      const text = selectionText(
        selection,
        (row) => fetched?.lines?.[row - (fetched?.start ?? first)] ?? "",
      );
      if (!text) return;
      await copyText(text, (data) => writeHost(stdout, data));
      if (config.ui.toast.clipboard_enabled) {
        pushToast({
          title: "copied to clipboard",
          context: "",
          tone: "clipboard",
          position: config.ui.toast.clipboard_position,
        }, 1_500);
      }
    })().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [config, connection, copyText, pushToast, stdout]);

  const handleChromeTarget = (target: ClickTarget | null) => {
    if (!target || !state) return;
    switch (target.kind) {
      case "workspace":
        setRemoteDashboardOpen(false);
        setRemoteScope(null);
        void connection.request({ type: "workspace.select", workspaceId: target.id });
        return;
      case "machine-toggle":
        setCollapsedMachines((current) => {
          const next = new Set(current);
          if (next.has(target.id)) next.delete(target.id);
          else next.add(target.id);
          return next;
        });
        return;
      case "machine": {
        if (target.id === LOCAL_MACHINE_ID) {
          setRemoteDashboardOpen(false);
          setRemoteScope(null);
          return;
        }
        const machine = state.machines.find((entry) => entry.id === target.id);
        if (!machine) return;
        const workspaceId = machine.remote?.activeWorkspaceId ??
          machine.remote?.workspaceList?.[0]?.id;
        if (workspaceId) {
          openRemoteWorkspace(machine.id, workspaceId);
          return;
        }
        setMessage(`${machine.label}: connecting…`);
        void connection.request({ type: "machine.refresh", labelOrId: machine.id }, 60_000)
          .then((view) => {
            const status = (view as { status?: string; error?: string | null });
            setMessage(`${machine.label}: ${status.status ?? "refreshed"}${status.error ? ` · ${status.error}` : ""}`);
          })
          .catch((error: unknown) => {
            setMessage(error instanceof Error ? error.message : String(error));
          });
        return;
      }
      case "remote-workspace":
        openRemoteWorkspace(target.machineId, target.workspaceId);
        return;
      case "agent":
        void connection.request({ type: "pane.focus", paneId: target.paneId });
        return;
      case "tab":
        void connection.request({ type: "tab.select", tabId: target.id });
        return;
      case "new-workspace":
        runKeyAction("new_workspace");
        return;
      case "new-tab":
        runKeyAction("new_tab");
        return;
      case "tabs-left":
        runKeyAction("previous_tab");
        return;
      case "tabs-right":
        runKeyAction("next_tab");
        return;
      case "agent-sort":
        setAgentSort((current) => current === "status" ? "spaces" : "status");
        return;
      case "agent-scroll":
        setAgentScroll(target.offset);
        return;
      case "sidebar-toggle":
        setSidebarCollapsed((collapsed) => !collapsed);
        return;
      case "group-toggle":
        toggleGroup(target.repoKey);
        return;
      case "menu":
        openGlobalMenu();
        return;
      case "menu-item": {
        const entry = GLOBAL_MENU[target.index];
        if (entry) runKeyAction(entry.action);
        return;
      }
      case "switcher-open":
        setNavigateIndex(Math.max(0, state.workspaces.findIndex((workspace) =>
          workspace.id === state.activeWorkspaceId
        )));
        setMobileScroll(0);
        setMode("navigate");
        return;
      case "switcher-close":
        setMode("terminal");
        return;
    }
  };

  const handleMouseInput = useCallback((event: MouseInputEvent) => {
    if (!state) return;
    if (menu) {
      if (event.action !== "press") return;
      const rect = menuRect(menu, screen.columns, screen.rows);
      const index = event.row - 1 - rect.y - 1;
      const inside = event.column - 1 >= rect.x &&
        event.column - 1 < rect.x + rect.width &&
        index >= 0 && index < menu.items.length;
      setMenu(null);
      if (inside && event.button === "left") menu.items[index]?.run();
      return;
    }
    if (navigator) {
      if (event.action === "press") setNavigator(null);
      return;
    }
    if (switcher && !overlayOpen) {
      // The phone-width switcher covers the screen: the wheel scrolls its
      // list and a tap activates a row, then returns to the panes.
      if (event.action === "wheel") {
        const step = event.direction === "up" ? -2 : 2;
        setMobileScroll(Math.max(0, Math.min(switcher.maxScroll, switcher.scroll + step)));
        return;
      }
      if (event.action !== "press" || event.button !== "left") return;
      const picked = targetAt(switcher.rows[event.row - 1], event.column - 1);
      if (!picked) return;
      setMode("terminal");
      if (picked.kind !== "switcher-close") handleChromeTarget(picked);
      return;
    }
    if (
      screen.header && event.row - 1 < screen.header.y + screen.header.height &&
      !overlayOpen && (event.action === "press" || event.action === "wheel")
    ) {
      // Only the switch button reacts in the header, and only outside
      // prefix and copy modes. Drags and releases fall through so a drag
      // that strays onto the header still ends.
      if (event.button === "left" && (mode === "terminal" || mode === "resize")) {
        const picked = targetAt(mobileHeader[event.row - 1 - screen.header.y], event.column - 1);
        if (picked?.kind === "switcher-open") handleChromeTarget(picked);
      }
      return;
    }
    // The remote dashboard leaves the sidebar usable for switching
    // between machines and workspaces.
    const dashboardOnly = remoteDashboardOpen && !(
      pluginPickerOpen || renameMode || remoteMode || remotePaneMode ||
      helpOpen || confirm || navigator || popup || settings
    );
    if (
      dashboardOnly &&
      event.action === "press" &&
      event.button === "left" &&
      event.column - 1 < screen.sidebar.width - 1
    ) {
      handleChromeTarget(targetAt(sidebarModel[event.row - 1], event.column - 1));
      return;
    }
    if (overlayOpen) return;
    const x = event.column - 1;
    const y = event.row - 1;
    const target = paneAt(geometries, x, y);
    const paneView = target
      ? state.panes.find((pane) => pane.id === target.paneId)
      : undefined;
    const appTracksMouse = paneView?.modes?.mouseTracking !== undefined &&
      paneView.modes.mouseTracking !== "none";

    // Forward to the app when it tracks the mouse. Shift bypasses it so the
    // user can still select text.
    const forwardToApp = (
      paneId: string,
      cellX: number,
      cellY: number,
      strip = appMouseStrip.current,
    ) => {
      const geometry = geometries.find((entry) => entry.paneId === paneId);
      if (!geometry) return;
      const cell = contentCell(geometry, cellX, cellY, chromeFor(paneId));
      void connection.request({
        type: "pane.mouse",
        paneId,
        col: cell.col,
        row: cell.row,
        button: event.action === "wheel"
          ? "wheel"
          : event.action === "move"
            ? "none"
            : event.button === "other"
              ? "left"
              : event.button,
        action: event.action === "wheel"
          ? (event.direction ?? "down")
          : event.action,
        ctrl: event.ctrl && !strip.ctrl,
        alt: event.alt && !strip.alt,
        shift: false,
      });
    };

    if (appMouseDrag.current) {
      forwardToApp(appMouseDrag.current, x, y);
      if (event.action === "release") {
        appMouseDrag.current = null;
        appMouseStrip.current = NO_STRIP;
      }
      return;
    }

    if (event.action === "wheel") {
      const agentViewport = x < screen.sidebar.width - 1 ? sidebarModel[y]?.agentScroll : undefined;
      if (agentViewport) {
        const step = (event.direction === "up" ? -1 : 1) * config.ui.mouse_scroll_lines;
        setAgentScroll(Math.max(0, Math.min(agentViewport.maxOffset, agentViewport.offset + step)));
        return;
      }
      if (!target) return;
      const cell = contentCell(target, x, y, chromeFor(target.paneId));
      if (appTracksMouse && !event.shift && cell.inside) {
        forwardToApp(target.paneId, x, y);
        return;
      }
      void connection.request({
        type: "surface.scroll",
        paneId: target.paneId,
        lines: (event.direction === "up" ? -1 : 1) * config.ui.mouse_scroll_lines,
      });
      return;
    }

    if (event.action === "release") {
      setDragPreview(null);
      const reorder = reorderDrag.current;
      reorderDrag.current = null;
      if (reorder?.moved) {
        if (
          reorder.kind === "tab" && screen.tabBar && tabBarModel && activeWorkspace &&
          y === screen.tabBar.y && x >= screen.tabBar.x &&
          x < screen.tabBar.x + screen.tabBar.width
        ) {
          const dropped = targetAt(tabBarModel, x - screen.tabBar.x);
          const index = dropped?.kind === "tab"
            ? activeWorkspace.tabs.findIndex((tab) => tab.id === dropped.id)
            : x < screen.tabBar.x + 2 ? 0 : activeWorkspace.tabs.length - 1;
          if (index >= 0) {
            void connection.request({ type: "tab.move", tabId: reorder.id, insertIndex: index });
          }
        } else if (reorder.kind === "workspace" && x < screen.sidebar.width) {
          const dropped = targetAt(sidebarModel[y], x);
          const index = dropped?.kind === "workspace"
            ? state.workspaces.findIndex((workspace) => workspace.id === dropped.id)
            : -1;
          if (index >= 0) {
            void connection.request({
              type: "workspace.move",
              workspaceId: reorder.id,
              insertIndex: index,
            });
          }
        }
        return;
      }
      if (selectionDrag.current) {
        const drag = selectionDrag.current;
        selectionDrag.current = null;
        if (!drag.moved) setTerminalSelection(null);
        else if (terminalSelection && config.ui.copy_on_select) {
          copySelection(terminalSelection);
        }
        return;
      }
      if (!splitDrag.current && paneDrag.current) {
        const drag = paneDrag.current;
        const distance = Math.abs(x - drag.x) + Math.abs(y - drag.y);
        if (target && target.paneId !== drag.paneId && distance > 2) {
          void connection.request({
            type: "pane.swap",
            paneId: drag.paneId,
            targetPaneId: target.paneId,
          });
          setMessage(`swapped ${drag.paneId} with ${target.paneId}`);
        }
      }
      splitDrag.current = null;
      paneDrag.current = null;
      sidebarDrag.current = false;
      return;
    }

    if (event.action === "drag") {
      if (reorderDrag.current) {
        const drag = reorderDrag.current;
        drag.moved = true;
        const overTabBar = drag.kind === "tab" && screen.tabBar &&
          y === screen.tabBar.y && x >= screen.tabBar.x &&
          x < screen.tabBar.x + screen.tabBar.width;
        const dropped = overTabBar && screen.tabBar
          ? targetAt(tabBarModel ?? undefined, x - screen.tabBar.x)
          : drag.kind === "workspace" && x < screen.sidebar.width
            ? targetAt(sidebarModel[y], x)
            : null;
        const title = drag.kind === "tab"
          ? activeWorkspace?.tabs.find((tab) => tab.id === drag.id)?.name ?? drag.id
          : state.workspaces.find((workspace) => workspace.id === drag.id)?.name ?? drag.id;
        setDragPreview({
          kind: drag.kind,
          title,
          x,
          y,
          canDrop: drag.kind === "tab"
            ? Boolean(overTabBar && (dropped?.kind !== "tab" || dropped.id !== drag.id))
            : dropped?.kind === "workspace" && dropped.id !== drag.id,
        });
        return;
      }
      if (sidebarDrag.current) {
        setSidebarWidth(Math.max(
          config.ui.sidebar_min_width,
          Math.min(config.ui.sidebar_max_width, x + 1),
        ));
        return;
      }
      if (splitDrag.current) {
        const drag = splitDrag.current;
        const axis = drag.direction === "right" ? x : y;
        const delta = (axis - drag.last) / Math.max(1, drag.span);
        if (delta !== 0) {
          drag.last = axis;
          void connection.request({
            type: "pane.resize-layout",
            paneId: drag.paneId,
            delta,
          });
        }
        return;
      }
      if (selectionDrag.current) {
        const geometry = geometries.find((entry) =>
          entry.paneId === selectionDrag.current?.paneId
        );
        if (!geometry) return;
        const cell = contentCell(geometry, x, y, chromeFor(geometry.paneId));
        const top = viewTop(surfaces[geometry.paneId]);
        selectionDrag.current.moved = true;
        setTerminalSelection((current) => current && current.paneId === geometry.paneId
          ? { ...current, head: { col: cell.col, row: top + cell.row } }
          : current);
        return;
      }
      if (paneDrag.current) {
        const drag = paneDrag.current;
        if (Math.abs(x - drag.x) + Math.abs(y - drag.y) > 2) {
          const source = state.panes.find((pane) => pane.id === drag.paneId);
          setDragPreview({
            kind: "pane",
            title: source?.title || source?.agent || drag.paneId,
            x,
            y,
            canDrop: Boolean(target && target.paneId !== drag.paneId),
          });
        }
      }
      return;
    }

    if (event.action === "press" && event.button === "right") {
      // ui.right_click_passthrough_modifier: exactly these modifiers send
      // the gesture to the app, with the modifiers removed.
      const passthrough = config.ui.right_click_passthrough_modifier;
      const modifierMatch = Boolean(
        passthrough && !passthrough.super && !event.shift &&
          Boolean(event.ctrl) === passthrough.ctrl && Boolean(event.alt) === passthrough.alt,
      );
      if (target && appTracksMouse && (modifierMatch || rightClickPanes.has(target.paneId))) {
        const strip = modifierMatch && passthrough
          ? { ctrl: passthrough.ctrl, alt: passthrough.alt }
          : NO_STRIP;
        forwardToApp(target.paneId, x, y, strip);
        appMouseDrag.current = target.paneId;
        appMouseStrip.current = strip;
        return;
      }
      const chromeTarget = x < screen.sidebar.width
        ? targetAt(sidebarModel[y], x)
        : screen.tabBar && y === screen.tabBar.y && tabBarModel
          ? targetAt(tabBarModel, x - screen.tabBar.x)
          : null;
      if (chromeTarget) openContextMenu(chromeTarget, x, y);
      else if (target) openContextMenu({ kind: "pane", paneId: target.paneId }, x, y);
      return;
    }
    if (event.action !== "press" || event.button !== "left") {
      if (event.action === "press" && target && appTracksMouse) {
        appMouseStrip.current = NO_STRIP;
        forwardToApp(target.paneId, x, y);
        appMouseDrag.current = target.paneId;
      }
      return;
    }

    if (x < screen.sidebar.width) {
      if (x === screen.sidebar.width - 1 && !sidebarCollapsed) {
        sidebarDrag.current = true;
        return;
      }
      const chromeTarget = targetAt(sidebarModel[y], x);
      if (chromeTarget?.kind === "workspace") {
        reorderDrag.current = { kind: "workspace", id: chromeTarget.id, moved: false };
      }
      handleChromeTarget(chromeTarget);
      return;
    }
    if (screen.tabBar && y === screen.tabBar.y && tabBarModel) {
      const chromeTarget = targetAt(tabBarModel, x - screen.tabBar.x);
      if (chromeTarget?.kind === "tab") {
        reorderDrag.current = { kind: "tab", id: chromeTarget.id, moved: false };
      }
      handleChromeTarget(chromeTarget);
      return;
    }

    const edge = splitAt(layout.splits, x, y, paneStyle);
    if (edge) {
      splitDrag.current = {
        paneId: edge.paneId,
        direction: edge.direction,
        last: edge.direction === "right" ? x : y,
        span: edge.span,
      };
      return;
    }

    if (!target) return;
    if (target.paneId !== state.focusedPaneId) {
      void connection.request({ type: "pane.focus", paneId: target.paneId });
    }
    const cell = contentCell(target, x, y, chromeFor(target.paneId));
    if (!cell.inside) {
      // Dragging a pane by its title or border swaps it with another pane.
      paneDrag.current = { paneId: target.paneId, x, y };
      return;
    }
    if (event.ctrl) {
      // Ctrl-click opens OSC 8 hyperlinks and plain URLs, as in Shepherd.
      const line = viewTop(surfaces[target.paneId]) + cell.row;
      void connection.request({
        type: "pane.link_at",
        paneId: target.paneId,
        line,
        col: cell.col,
      }).then(async (result) => {
        const url = (result as { url: string | null }).url;
        if (!url) return;
        // A plugin link handler matching the URL takes it instead.
        const handled = await connection.request({
          type: "plugin.link-open",
          url,
          paneId: target.paneId,
        }).catch(() => null) as { handled?: boolean; pluginId?: string; actionId?: string } | null;
        if (handled?.handled) {
          setMessage(`${handled.pluginId}.${handled.actionId} ← ${url}`);
          return;
        }
        openUrl(url);
        setMessage(`opened ${url}`);
      }).catch(() => {});
      return;
    }
    if (appTracksMouse && !event.shift) {
      appMouseStrip.current = NO_STRIP;
      forwardToApp(target.paneId, x, y);
      appMouseDrag.current = target.paneId;
      return;
    }

    const now = Date.now();
    const previous = lastClick.current;
    const doubleClick = previous !== null &&
      now - previous.at < 350 &&
      previous.paneId === target.paneId &&
      previous.row === cell.row &&
      Math.abs(previous.col - cell.col) <= 1;
    lastClick.current = { at: now, paneId: target.paneId, col: cell.col, row: cell.row };
    const top = viewTop(surfaces[target.paneId]);
    if (doubleClick) {
      const line = surfaces[target.paneId]?.lines[cell.row] ?? [];
      const [start, end] = wordAt(line, cell.col);
      const selection: TextSelection = {
        paneId: target.paneId,
        anchor: { col: start, row: top + cell.row },
        head: { col: end, row: top + cell.row },
        mode: "word",
      };
      setTerminalSelection(selection);
      if (config.ui.copy_on_select) copySelection(selection);
      return;
    }
    selectionDrag.current = { paneId: target.paneId, moved: false };
    setTerminalSelection({
      paneId: target.paneId,
      anchor: { col: cell.col, row: top + cell.row },
      head: { col: cell.col, row: top + cell.row },
      mode: "char",
    });
  }, [
    activeWorkspace,
    chromeFor,
    connection,
    copySelection,
    geometries,
    layout.splits,
    mobileHeader,
    mode,
    overlayOpen,
    paneStyle,
    remoteDashboardOpen,
    screen,
    sidebarModel,
    state,
    surfaces,
    switcher,
    terminalSelection,
  ]);

  const pendingInput = useRef<{ paneId: string; data: string } | null>(null);
  const sendPaneInput = useCallback((paneId: string, data: string) => {
    const pending = pendingInput.current;
    if (pending && pending.paneId === paneId) {
      pending.data += data;
      return;
    }
    if (pending) {
      void connection.request({ type: "pane.input", ...pending });
    }
    pendingInput.current = { paneId, data };
    setImmediate(() => {
      const batch = pendingInput.current;
      pendingInput.current = null;
      if (batch) void connection.request({ type: "pane.input", ...batch });
    });
  }, [connection]);

  const handlePaste = (text: string) => {
    if (popup) {
      void connection.request({ type: "pane.paste", paneId: popup.paneId, text });
      return;
    }
    const singleLine = text.replace(/\r?\n/g, " ");
    if (remotePaneMode === "input") {
      setRemotePaneInput((current) => `${current}${singleLine}`.slice(0, 500));
    } else if (remoteMode === "prompt") {
      setRemotePrompt((current) => `${current}${singleLine}`.slice(0, 500));
    } else if (renameMode) {
      setRenameField((current) => insertText(current, singleLine, 80));
    } else if (
      state &&
      !prefix &&
      !pluginPickerOpen &&
      !remoteMode &&
      !remotePaneMode &&
      !remoteDashboardOpen
    ) {
      void connection.request({
        type: "pane.paste",
        paneId: state.focusedPaneId,
        text,
      });
    }
  };

  // Keys consumed by the UI (prefix, pickers, text fields) change React state.
  // Later tokens from the same stdin chunk must wait for that state to
  // render, otherwise `Ctrl+B %` followed by fast typing sees a stale prefix.
  const tokenQueue = useRef<InputToken[]>([]);
  const awaitingRender = useRef(false);
  const [inputTick, setInputTick] = useState(0);
  let keyForwarded = false;

  const dispatchToken = (token: InputToken): boolean => {
    if (token.kind === "mouse") {
      handleMouseInput(token.event);
      return false;
    }
    if (token.kind === "paste") {
      handlePaste(token.text);
      return false;
    }
    if (token.kind === "appearance") {
      // An explicit scheme report outranks one inferred from the background.
      if (token.explicit || !appearanceExplicit.current) {
        appearanceExplicit.current ||= token.explicit;
        setAppearance(token.appearance);
      }
      return false;
    }
    if (token.kind === "focus") {
      hostFocused.current = token.focused;
      if (token.focused && config.theme.auto_switch) writeHost(stdout, APPEARANCE_QUERY);
      if (state) {
        void connection.request({
          type: "pane.focus-report",
          paneId: state.focusedPaneId,
          focused: token.focused,
        });
      }
      return false;
    }
    if (token.kind !== "key") return false;
    keyForwarded = false;
    const { input, key } = inkStyle(token.key);
    handleKey(input, key, token.key);
    return !keyForwarded;
  };

  const drainInput = () => {
    while (tokenQueue.current.length > 0 && !awaitingRender.current) {
      const token = tokenQueue.current.shift();
      if (token && dispatchToken(token)) {
        awaitingRender.current = true;
        setInputTick((tick) => tick + 1);
      }
    }
  };

  useEffect(() => {
    awaitingRender.current = false;
    drainInput();
  }, [inputTick]);

  const focusedTracksMouse = Boolean(
    state && surfaces[state.focusedPaneId]?.modes?.mouseTracking &&
      surfaces[state.focusedPaneId]?.modes.mouseTracking !== "none",
  );
  useTerminalInput((token: InputToken) => {
    tokenQueue.current.push(token);
    drainInput();
  }, config.ui.mouse_capture || focusedTracksMouse, config.theme.auto_switch);

  const handleKey = (input: string, key: InkStyleKey, press: KeyPress) => {
    if (dragPreview && key.escape) {
      reorderDrag.current = null;
      paneDrag.current = null;
      splitDrag.current = null;
      setDragPreview(null);
      return;
    }
    if (popup) {
      keyForwarded = true;
      sendPaneInput(popup.paneId, paneKeyBytes(press, surfaces[popup.paneId]?.modes));
      return;
    }
    if (remoteDashboardOpen) {
      if (key.escape) {
        setRemoteDashboardOpen(false);
        setRemoteScope(null);
        setMessage("remote dashboard closed");
      }
      return;
    }

    if (remotePaneMode === "input") {
      if (key.escape) {
        setRemotePaneInput("");
        setRemotePaneMode("view");
      } else if (key.return) {
        void sendRemotePaneInput();
      } else if (key.backspace || key.delete) {
        setRemotePaneInput((current) =>
          current.slice(0, Math.max(0, current.length - 1)));
      } else if (input && !key.ctrl && !key.meta) {
        setRemotePaneInput((current) => `${current}${input}`.slice(0, 500));
      }
      return;
    }

    if (remotePaneMode === "view") {
      if (key.escape) {
        setRemotePaneMode("picker");
      } else if (key.return) {
        setRemotePaneMode("input");
      }
      return;
    }

    if (remotePaneMode === "picker") {
      if (key.escape) {
        setRemotePaneMode(null);
        setMessage("remote pane picker closed");
      } else if (key.upArrow) {
        setSelectedRemotePane((current) => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setSelectedRemotePane((current) =>
          Math.min(remotePanes.length - 1, current + 1));
      } else if (key.return) {
        void readRemotePane();
      }
      return;
    }

    if (remoteMode === "prompt") {
      if (key.escape) {
        setRemotePrompt("");
        setRemoteMode("read");
      } else if (key.return) {
        void sendRemotePrompt();
      } else if (key.backspace || key.delete) {
        setRemotePrompt((current) => current.slice(0, Math.max(0, current.length - 1)));
      } else if (input && !key.ctrl && !key.meta) {
        setRemotePrompt((current) => `${current}${input}`.slice(0, 500));
      }
      return;
    }

    if (remoteMode === "read") {
      if (key.escape) {
        setRemoteMode("picker");
      } else if (key.return) {
        setRemoteMode("prompt");
      }
      return;
    }

    if (remoteMode === "picker") {
      if (key.escape) {
        setRemoteMode(null);
        setMessage("remote agent picker closed");
      } else if (key.upArrow) {
        setSelectedRemoteAgent((current) => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setSelectedRemoteAgent((current) =>
          Math.min(remoteAgents.length - 1, current + 1));
      } else if (key.return) {
        void readRemoteAgent();
      }
      return;
    }

    if (pluginPickerOpen) {
      if (key.escape) {
        setPluginPickerOpen(false);
        setMessage("plugin picker closed");
      } else if (key.upArrow) {
        setSelectedPluginAction((current) => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setSelectedPluginAction((current) =>
          Math.min(pluginActions.length - 1, current + 1));
      } else if (key.return) {
        void invokeSelectedPluginAction();
      }
      return;
    }

    if (renameMode) {
      if (key.escape) {
        setRenameMode(null);
        setRenameDraft("");
        renameTarget.current = null;
        setMessage("rename cancelled");
      } else if (key.return) {
        void submitRename();
      } else {
        const next = editText(renameField, press, 80);
        if (next) setRenameField(next);
      }
      return;
    }

    if (menu) {
      if (key.escape) {
        setMenu(null);
      } else if (key.upArrow || input === "k") {
        setMenu({ ...menu, selected: Math.max(0, menu.selected - 1) });
      } else if (key.downArrow || input === "j") {
        setMenu({ ...menu, selected: Math.min(menu.items.length - 1, menu.selected + 1) });
      } else if (key.return) {
        const item = menu.items[menu.selected];
        setMenu(null);
        item?.run();
      }
      return;
    }

    if (navigator) {
      handleNavigatorKey(press, input, key);
      return;
    }

    if (settings) {
      handleSettingsKey(input, key);
      return;
    }

    if (confirm) {
      if (input === "y" || key.return) {
        const action = confirm.onConfirm;
        setConfirm(null);
        action();
      } else if (input === "n" || key.escape) {
        setConfirm(null);
        setMessage("cancelled");
      }
      return;
    }

    if (helpOpen) {
      if (key.escape || (press.name === "?" && !helpFilter)) {
        setHelpOpen(false);
        setHelpFilter("");
      } else if (key.backspace) {
        setHelpFilter((current) => current.slice(0, -1));
      } else if (press.ctrl && press.name === "u") {
        setHelpFilter("");
      } else if (input && !key.ctrl && !key.meta) {
        setHelpFilter((current) => `${current}${input}`.slice(0, 40));
      }
      return;
    }

    const combo = comboKey(press);

    if (mode === "prefix") {
      const returnMode: Mode = copyState?.paneId === state?.focusedPaneId
        ? "copy"
        : "terminal";
      setMode(returnMode);
      if (combo === keymap.prefix) {
        if (state) {
          sendPaneInput(
            state.focusedPaneId,
            paneKeyBytes(press, surfaces[state.focusedPaneId]?.modes),
          );
        }
        return;
      }
      if (key.escape) {
        setMessage("");
        return;
      }
      const commandIndex = keymap.commandsPrefixed.get(combo);
      if (commandIndex !== undefined) {
        runCustomCommand(commandIndex);
        return;
      }
      const binding = keymap.prefixed.get(combo);
      if (binding) runKeyAction(binding.action, binding.index);
      return;
    }

    if (mode === "resize") {
      const direction = navDirection(press, {
        left: "h",
        down: "j",
        up: "k",
        right: "l",
      });
      if (direction) {
        void runAction(
          () => connection.request({ type: "pane.resize", direction }),
          `resize ${direction}`,
        );
        return;
      }
      if (
        key.escape || key.return || combo === keymap.prefix ||
        keymap.prefixed.get(combo)?.action === "resize_mode"
      ) {
        setMode("terminal");
        setMessage("");
      }
      return;
    }

    if (mode === "navigate") {
      handleNavigateKey(press, combo, input, key);
      return;
    }

    if (mode === "copy") {
      if (combo === keymap.prefix && !searchPrompt) {
        setMode("prefix");
        return;
      }
      handleCopyKey(press, input, key);
      return;
    }

    if (combo === keymap.prefix) {
      setMode("prefix");
      return;
    }

    const directCommand = keymap.commandsDirect.get(combo);
    if (directCommand !== undefined) {
      runCustomCommand(directCommand);
      return;
    }
    const direct = keymap.direct.get(combo);
    if (direct) {
      runKeyAction(direct.action, direct.index);
      return;
    }

    if (!state) return;
    const focusedSurface = surfaces[state.focusedPaneId];
    if (
      (press.name === "pageup" || press.name === "pagedown") &&
      !press.ctrl && !press.alt && !press.shift &&
      isShellLike(focusedSurface?.modes)
    ) {
      const page = Math.max(1, (focusedSurface?.rows ?? 2) - 1);
      void connection.request({
        type: "surface.scroll",
        paneId: state.focusedPaneId,
        lines: press.name === "pageup" ? -page : page,
      });
      return;
    }
    keyForwarded = true;
    sendPaneInput(state.focusedPaneId, paneKeyBytes(press, surfaces[state.focusedPaneId]?.modes));
  };

  const openNavigatorItem = (item: NavigatorItem | undefined) => {
    setNavigator(null);
    if (!item) return;
    if (item.kind === "pane" && item.paneId) {
      void connection.request({ type: "pane.focus", paneId: item.paneId });
    } else {
      void connection.request({ type: "workspace.select", workspaceId: item.workspace.id });
    }
  };

  const handleNavigatorKey = (press: KeyPress, input: string, key: InkStyleKey) => {
    if (!state || !navigator) return;
    const items = navigatorItems(state, navigator.query, navigator.filter);
    const move = (direction: 1 | -1, steps = 1) => setNavigator({
      ...navigator,
      selected: nextPaneItem(items, navigator.selected, direction, steps),
    });
    const update = (next: Partial<NavigatorState>) => {
      const merged = { ...navigator, ...next };
      const nextItems = navigatorItems(state, merged.query, merged.filter);
      setNavigator({ ...merged, selected: firstPaneItem(nextItems) });
    };
    if (key.return) {
      openNavigatorItem(items[navigator.selected]);
      return;
    }
    if (key.upArrow || (press.ctrl && press.name === "p")) return move(-1);
    if (key.downArrow || (press.ctrl && press.name === "n")) return move(1);
    if (navigator.searching) {
      if (key.escape) {
        setNavigator({ ...navigator, searching: false });
      } else if (key.backspace) {
        update({ query: navigator.query.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        update({ query: `${navigator.query}${input}` });
      }
      return;
    }
    if (key.escape) {
      setNavigator(null);
      return;
    }
    if (input === "j") return move(1);
    if (input === "k") return move(-1);
    if (press.ctrl && press.name === "d") return move(1, 8);
    if (press.ctrl && press.name === "u") return move(-1, 8);
    if (press.name === "home") {
      return setNavigator({ ...navigator, selected: firstPaneItem(items) });
    }
    if (press.name === "end" || input === "G") {
      return setNavigator({ ...navigator, selected: nextPaneItem(items, items.length, -1) });
    }
    if (key.leftArrow || key.rightArrow) {
      const direction = key.rightArrow ? 1 : -1;
      let index = navigator.selected + direction;
      while (index >= 0 && index < items.length && items[index]?.kind !== "workspace") {
        index += direction;
      }
      if (direction === -1) {
        index -= 1;
        while (index >= 0 && items[index]?.kind !== "workspace") index -= 1;
      }
      if (index >= 0 && index < items.length) {
        setNavigator({ ...navigator, selected: nextPaneItem(items, index, 1) });
      }
      return;
    }
    if (input === "/") return setNavigator({ ...navigator, searching: true });
    const filters: Record<string, StatusFilter> = {
      a: "all",
      b: "blocked",
      w: "working",
      i: "idle",
      d: "done",
    };
    if (input && filters[input]) return update({ filter: filters[input] });
    if (key.backspace) update({ filter: "all", query: "" });
  };

  const handleSettingsKey = (input: string, key: InkStyleKey) => {
    if (!settings) return;
    const options = settingsOptions(settings.tab, config);
    const tabIndex = SETTINGS_TABS.indexOf(settings.tab);
    if (key.escape || input === "q") {
      setSettings(null);
    } else if (key.leftArrow || key.rightArrow || key.tab) {
      const offset = key.leftArrow || (key.tab && key.shift) ? -1 : 1;
      const tab = SETTINGS_TABS[(tabIndex + offset + SETTINGS_TABS.length) % SETTINGS_TABS.length];
      if (tab) {
        const next = settingsOptions(tab, config);
        setSettings({ tab, selected: Math.max(0, next.findIndex((option) => option.current)) });
      }
    } else if (key.upArrow || input === "k") {
      setSettings({ ...settings, selected: Math.max(0, settings.selected - 1) });
    } else if (key.downArrow || input === "j") {
      setSettings({ ...settings, selected: Math.min(options.length - 1, settings.selected + 1) });
    } else if (key.return) {
      const option = options[settings.selected];
      if (!option) return;
      try {
        if (loadedConfig.path) {
          writeConfigValue(loadedConfig.path, option.section, option.key, option.value);
          setLoadedConfig(reloadConfig());
        } else {
          // No config file (tests, embedded): apply in memory only.
          const next = structuredClone(loadedConfig);
          applySettingInMemory(next.config, option);
          setLoadedConfig(next);
        }
        setMessage(`${option.key.replaceAll("_", " ")}: ${option.label}`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const toggleGroup = (repoKey: string) => setCollapsedGroups((current) => {
    const next = new Set(current);
    if (next.has(repoKey)) next.delete(repoKey);
    else next.add(repoKey);
    return next;
  });

  const newWorktree = (workspaceId: string) => {
    renameTarget.current = workspaceId;
    setRenameDraft("");
    setRenameMode("new-worktree");
  };

  const openWorktreeMenu = (workspaceId: string, x: number, y: number) => {
    void connection.request({ type: "worktree.list", workspaceId }).then((result) => {
      const worktrees = (result as Array<{
        path: string;
        branch: string | null;
        openWorkspaceId: string | null;
      }>).filter((worktree) => !worktree.openWorkspaceId);
      if (worktrees.length === 0) {
        setMessage("no other worktrees to open");
        return;
      }
      setMenu({
        x,
        y,
        selected: 0,
        items: worktrees.map((worktree) => ({
          label: worktree.branch ?? worktree.path,
          run: () => void runAction(
            () => connection.request({ type: "worktree.open", path: worktree.path }),
            `opened ${worktree.branch ?? worktree.path}`,
          ),
        })),
      });
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  };

  const removeWorktree = (workspaceId: string) => {
    const workspace = state?.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace?.git?.linked) {
      setMessage("not a linked worktree");
      return;
    }
    const remove = (force: boolean) => {
      void connection.request({ type: "worktree.remove", workspaceId, force }, 60_000)
        .then(() => setMessage("worktree removed"))
        .catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          if (!force && /modified|untracked|--force/.test(text)) {
            setConfirm({
              message: "The worktree has changes. Delete it anyway?",
              onConfirm: () => remove(true),
            });
          } else {
            setMessage(text);
          }
        });
    };
    setConfirm({
      message: `Delete worktree checkout ${workspace.git.checkoutPath}?`,
      onConfirm: () => remove(false),
    });
  };

  const openGlobalMenu = () => {
    const items: MenuItem[] = GLOBAL_MENU.map((entry) => ({
      label: entry.label,
      run: () => runKeyAction(entry.action),
    }));
    setMenu({
      items,
      selected: 0,
      x: Math.max(0, screen.sidebar.width - 16),
      y: Math.max(0, Math.round(screen.rows * 0.5) - 1 - (items.length + 2)),
    });
  };

  const openContextMenu = (target: ClickTarget | { kind: "pane"; paneId: string }, x: number, y: number) => {
    if (!state) return;
    let items: MenuItem[] = [];
    if (target.kind === "workspace") {
      const workspace = state.workspaces.find((entry) => entry.id === target.id);
      const git = workspace?.git;
      const children = git && !git.linked
        ? state.workspaces.filter((entry) =>
          entry.git?.linked && entry.git.repoKey === git.repoKey
        ).length
        : 0;
      items = [
        ...(git && !git.linked
          ? [
            { label: "New worktree", run: () => newWorktree(target.id) },
            { label: "Open worktree...", run: () => openWorktreeMenu(target.id, x, y) },
          ]
          : []),
        ...(git?.linked
          ? [{ label: "Delete worktree checkout...", run: () => removeWorktree(target.id) }]
          : []),
        ...(children > 0 && git
          ? [{
            label: collapsedGroups.has(git.repoKey) ? "Expand" : "Collapse",
            run: () => toggleGroup(git.repoKey),
          }]
          : []),
        {
          label: "Rename",
          run: () => {
            renameTarget.current = target.id;
            const workspace = state.workspaces.find((entry) => entry.id === target.id);
            setRenameDraft(workspace?.name ?? "");
            setRenameMode("workspace");
          },
        },
        {
          label: "Close",
          run: () => {
            const workspace = state.workspaces.find((entry) => entry.id === target.id);
            const close = () => void runAction(
              () => connection.request({ type: "workspace.close", workspaceId: target.id }),
              "workspace closed",
            );
            if (config.ui.confirm_close && workspace) {
              setConfirm({
                message: `Close workspace ${workspaceLabelOf(workspace)} and all its panes?`,
                onConfirm: close,
              });
            } else {
              close();
            }
          },
        },
      ];
    } else if (target.kind === "tab") {
      items = [
        { label: "New tab", run: () => runKeyAction("new_tab") },
        {
          label: "Rename",
          run: () => {
            renameTarget.current = target.id;
            const tab = activeWorkspace?.tabs.find((entry) => entry.id === target.id);
            setRenameDraft(tab?.name ?? "");
            setRenameMode("tab");
          },
        },
        {
          label: "Close",
          run: () => void runAction(
            () => connection.request({ type: "tab.close", tabId: target.id }),
            "tab closed",
          ),
        },
      ];
    } else if (target.kind === "pane") {
      const pane = state.panes.find((entry) => entry.id === target.paneId);
      const sendsRightClicks = rightClickPanes.has(target.paneId);
      items = [
        {
          label: "Rename pane",
          run: () => {
            renameTarget.current = target.paneId;
            setRenameDraft(pane?.title ?? "");
            setRenameMode("pane");
          },
        },
        ...(pane?.title
          ? [{
            label: "Clear pane name",
            run: () => void connection.request({
              type: "pane.rename",
              paneId: target.paneId,
              title: "",
            }),
          }]
          : []),
        ...(target.paneId !== state.focusedPaneId
          ? [{
            label: "Swap with focused pane",
            run: () => void connection.request({
              type: "pane.swap",
              paneId: state.focusedPaneId,
              targetPaneId: target.paneId,
            }),
          }]
          : []),
        {
          label: "Split right",
          run: () => void connection.request({ type: "pane.focus", paneId: target.paneId })
            .then(() => connection.request({ type: "pane.create", direction: "right" })),
        },
        {
          label: "Split down",
          run: () => void connection.request({ type: "pane.focus", paneId: target.paneId })
            .then(() => connection.request({ type: "pane.create", direction: "down" })),
        },
        {
          label: "Zoom",
          run: () => void connection.request({ type: "pane.zoom", paneId: target.paneId }),
        },
        {
          label: sendsRightClicks ? "Use Shepherd right-click menu" : "Send right-clicks to pane",
          run: () => setRightClickPanes((current) => {
            const next = new Set(current);
            if (next.has(target.paneId)) next.delete(target.paneId);
            else next.add(target.paneId);
            return next;
          }),
        },
        {
          label: "Close pane",
          run: () => void connection.request({ type: "pane.close", paneId: target.paneId }),
        },
      ];
    }
    if (items.length > 0) setMenu({ items, selected: 0, x, y });
  };

  const handleNavigateKey = (
    press: KeyPress,
    combo: string,
    input: string,
    key: InkStyleKey,
  ) => {
    if (!state) return;
    const navigate = config.keys.navigate;
    if (key.escape || combo === keymap.prefix) {
      setMode("terminal");
      setMessage("");
      return;
    }
    if (key.return) {
      const workspace = state.workspaces[navigateIndex];
      setMode("terminal");
      if (workspace) {
        void connection.request({ type: "workspace.select", workspaceId: workspace.id });
      }
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const workspace = state.workspaces[Number(input) - 1];
      setMode("terminal");
      if (workspace) {
        void connection.request({ type: "workspace.select", workspaceId: workspace.id });
      }
      return;
    }
    const count = Math.max(1, state.workspaces.length);
    // The sidebar wraps at the ends; the phone-width switcher stops.
    const step = (delta: number) => setNavigateIndex((index) => screen.mobile
      ? Math.max(0, Math.min(count - 1, index + delta))
      : (index + delta + count) % count);
    if (combo === navigate.workspace_up || press.name === "up") {
      step(-1);
      return;
    }
    if (combo === navigate.workspace_down || press.name === "down") {
      step(1);
      return;
    }
    const direction = combo === navigate.pane_left || press.name === "left"
      ? "left"
      : combo === navigate.pane_right || press.name === "right"
        ? "right"
        : combo === navigate.pane_up
          ? "up"
          : combo === navigate.pane_down
            ? "down"
            : null;
    if (direction) {
      void connection.request({ type: "pane.focus_direction", direction });
      return;
    }
    if (press.name === "tab") {
      focusOffset(press.shift ? -1 : 1);
      return;
    }
    const binding = keymap.prefixed.get(combo);
    if (binding) {
      setMode("terminal");
      runKeyAction(binding.action, binding.index);
    }
  };


  const copyTextCache = useRef<{
    paneId: string;
    start: number;
    lines: string[];
    total: number;
  } | null>(null);

  const copyBuffer = (paneId: string) => {
    const cache = copyTextCache.current;
    const page = surfaces[paneId]?.rows ?? 24;
    return {
      total: cache?.paneId === paneId ? cache.total : 1,
      page,
      text: (line: number) =>
        cache?.paneId === paneId ? cache.lines[line - cache.start] ?? "" : "",
    };
  };

  const refreshCopyText = async (paneId: string) => {
    const result = await connection.request({
      type: "pane.text",
      paneId,
      start: 0,
      count: 100_000,
    }) as { start: number; lines: string[]; total: number };
    copyTextCache.current = { paneId, ...result };
    return result;
  };

  /** Scrolls the client's view so the copy cursor is visible. */
  const revealCopyCursor = (paneId: string, line: number) => {
    const surface = surfaces[paneId];
    if (!surface) return;
    const top = viewTop(surface);
    const rows = surface.rows;
    let nextTop: number | null = null;
    if (line < top) nextTop = line;
    else if (line >= top + rows) nextTop = line - rows + 1;
    if (nextTop === null) return;
    void connection.request({
      type: "surface.scroll_to",
      paneId,
      top: nextTop >= surface.scroll.maxOffsetFromBottom ? null : nextTop,
    });
  };

  const exitCopyMode = () => {
    const current = copyState;
    setCopyState(null);
    setSearchPrompt(null);
    setMode("terminal");
    setTerminalSelection(null);
    if (current) {
      void connection.request({ type: "surface.scroll_to", paneId: current.paneId, top: null });
    }
  };

  const handleCopyKey = (press: KeyPress, input: string, key: InkStyleKey) => {
    const copy = copyState;
    if (!copy) {
      setMode("terminal");
      return;
    }
    if (searchPrompt) {
      if (key.escape) {
        setSearchPrompt(null);
      } else if (key.return) {
        const query = searchPrompt.text;
        setSearchPrompt(null);
        if (query) runCopySearch(query, searchPrompt.direction, copy);
      } else if (key.backspace) {
        setSearchPrompt({ ...searchPrompt, text: searchPrompt.text.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        setSearchPrompt({ ...searchPrompt, text: `${searchPrompt.text}${input}` });
      }
      return;
    }
    if (key.escape) {
      if (copy.anchor || copy.search) {
        setCopyState({ ...copy, anchor: null, search: null });
        setTerminalSelection(null);
      } else {
        exitCopyMode();
      }
      return;
    }
    if (input === "q") {
      exitCopyMode();
      return;
    }
    if (input === "y" || key.return) {
      if (copy.anchor) {
        copySelection(copySelectionOf(copy));
      }
      exitCopyMode();
      return;
    }
    if (input === "v" || press.name === "space") {
      const next = { ...copy, anchor: copy.anchor ? null : copy.cursor, lineMode: false };
      setCopyState(next);
      setTerminalSelection(next.anchor ? copySelectionOf(next) : null);
      return;
    }
    if (input === "V") {
      const next = { ...copy, anchor: copy.anchor && copy.lineMode ? null : copy.cursor, lineMode: true };
      setCopyState(next);
      setTerminalSelection(next.anchor ? copySelectionOf(next) : null);
      return;
    }
    if (input === "/" || input === "?") {
      setSearchPrompt({ direction: input === "/" ? "forward" : "backward", text: "" });
      return;
    }
    if ((input === "n" || input === "N") && copy.search) {
      const forward = copy.search.direction === "forward";
      runCopySearch(
        copy.search.query,
        (input === "n") === forward ? "forward" : "backward",
        copy,
      );
      return;
    }
    const motion = copyMotionForKey(press);
    if (!motion) return;
    const cursor = moveCopyCursor(copy.cursor, motion, copyBuffer(copy.paneId));
    const next = { ...copy, cursor };
    setCopyState(next);
    if (next.anchor) setTerminalSelection(copySelectionOf(next));
    revealCopyCursor(copy.paneId, cursor.line);
    // Output may have grown past the cached text; refresh in the background.
    if (motion === "bottom" || motion === "down" || motion === "page_down") {
      void refreshCopyText(copy.paneId);
    }
  };

  const runCopySearch = (
    query: string,
    direction: "forward" | "backward",
    copy: NonNullable<typeof copyState>,
  ) => {
    void (async () => {
      const result = await connection.request({
        type: "pane.search",
        paneId: copy.paneId,
        query,
        line: copy.cursor.line,
        col: copy.cursor.col,
        direction,
      }) as { match: { line: number; col: number } | null };
      if (!result.match) {
        setMessage(`not found: ${query}`);
        setCopyState({ ...copy, search: { query, direction } });
        return;
      }
      await refreshCopyText(copy.paneId);
      const next = {
        ...copy,
        cursor: { line: result.match.line, col: result.match.col },
        search: { query, direction },
      };
      setCopyState(next);
      if (next.anchor) setTerminalSelection(copySelectionOf(next));
      revealCopyCursor(copy.paneId, result.match.line);
    })().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  };

  const cycleAgent = (offset: number) => {
    if (!state) return;
    const agents = state.panes.filter((pane) => pane.agent);
    if (agents.length === 0) {
      setMessage("no agents");
      return;
    }
    const current = agents.findIndex((pane) => pane.id === state.focusedPaneId);
    const next = agents[(current + offset + agents.length) % agents.length];
    if (next) void connection.request({ type: "pane.focus", paneId: next.id });
  };

  const closeActiveTab = () => {
    if (!state || !activeTab) return;
    void runAction(
      () => connection.request({ type: "tab.close", tabId: activeTab.id }),
      "tab closed",
    );
  };

  const closeActiveWorkspace = () => {
    if (!state || !activeWorkspace) return;
    void runAction(
      () => connection.request({
        type: "workspace.close",
        workspaceId: activeWorkspace.id,
      }),
      "workspace closed",
    );
  };

  const runKeyAction = (action: Action, index?: number) => {
    if (!state) return;
    const focusedPaneId = state.focusedPaneId;
    switch (action) {
      case "toggle_agent_sort":
        setAgentSort((current) => current === "status" ? "spaces" : "status");
        return;
      case "help":
        setHelpFilter("");
        setHelpOpen(true);
        return;
      case "detach":
        connection.close();
        exit();
        return;
      case "reload_config": {
        const next = reloadConfig();
        setLoadedConfig(next);
        void connection.request({ type: "server.reload_config" }).catch(() => {});
        setMessage(next.diagnostics.length
          ? `config reloaded with ${next.diagnostics.length} warning(s)`
          : "config reloaded");
        return;
      }
      case "settings": {
        const options = settingsOptions("theme", config);
        setSettings({
          tab: "theme",
          selected: Math.max(0, options.findIndex((option) => option.current)),
        });
        return;
      }
      case "new_worktree":
        newWorktree(state.activeWorkspaceId);
        return;
      case "open_worktree":
        openWorktreeMenu(state.activeWorkspaceId, screen.sidebar.width, 2);
        return;
      case "remove_worktree":
        removeWorktree(state.activeWorkspaceId);
        return;
      case "goto": {
        const items = navigatorItems(state, "", "all");
        setNavigator({
          query: "",
          searching: false,
          filter: "all",
          selected: firstPaneItem(items, state.focusedPaneId),
        });
        return;
      }
      case "open_notification_target": {
        const target = notificationTarget.current;
        if (target && state.panes.some((pane) => pane.id === target)) {
          void connection.request({ type: "pane.focus", paneId: target });
          setToasts([]);
        } else {
          setMessage("no notification to open");
        }
        return;
      }
      case "workspace_picker":
        setNavigateIndex(Math.max(0, state.workspaces.findIndex((workspace) =>
          workspace.id === state.activeWorkspaceId
        )));
        setMobileScroll(0);
        setMode("navigate");
        return;
      case "new_workspace":
        if (config.ui.prompt_new_workspace_name) {
          setRenameDraft("");
          setRenameMode("new-workspace");
        } else {
          void runAction(
            () => connection.request({ type: "workspace.create" }),
            "workspace created",
          );
        }
        return;
      case "rename_workspace":
        setRenameMode("workspace");
        setRenameDraft(activeWorkspace?.name ?? "");
        return;
      case "close_workspace":
        if (config.ui.confirm_close && activeWorkspace) {
          setConfirm({
            message: `Close workspace ${activeWorkspace.name} and all its panes?`,
            onConfirm: closeActiveWorkspace,
          });
        } else {
          closeActiveWorkspace();
        }
        return;
      case "previous_workspace":
        selectWorkspaceOffset(-1);
        return;
      case "next_workspace":
        selectWorkspaceOffset(1);
        return;
      case "switch_workspace": {
        const workspace = state.workspaces[index ?? 0];
        if (workspace) {
          void connection.request({ type: "workspace.select", workspaceId: workspace.id });
        }
        return;
      }
      case "previous_agent":
        cycleAgent(-1);
        return;
      case "next_agent":
        cycleAgent(1);
        return;
      case "focus_agent": {
        const agent = state.panes.filter((pane) => pane.agent)[index ?? 0];
        if (agent) void connection.request({ type: "pane.focus", paneId: agent.id });
        return;
      }
      case "new_tab":
        if (config.ui.prompt_new_tab_name) {
          setRenameDraft("");
          setRenameMode("new-tab");
        } else {
          void runAction(() => connection.request({ type: "tab.create" }), "tab created");
        }
        return;
      case "rename_tab":
        setRenameMode("tab");
        setRenameDraft(activeTab?.name ?? "");
        return;
      case "previous_tab":
      case "next_tab": {
        const tabs = activeWorkspace?.tabs ?? [];
        const current = tabs.findIndex((tab) => tab.id === state.activeTabId);
        const offset = action === "next_tab" ? 1 : -1;
        const next = tabs[(current + offset + tabs.length) % Math.max(1, tabs.length)];
        if (next) void connection.request({ type: "tab.select", tabId: next.id });
        return;
      }
      case "move_tab_previous":
      case "move_tab_next": {
        const tabs = activeWorkspace?.tabs ?? [];
        const current = tabs.findIndex((tab) => tab.id === state.activeTabId);
        const target = current + (action === "move_tab_next" ? 1 : -1);
        if (current === -1 || target < 0 || target >= tabs.length) return;
        void connection.request({
          type: "tab.move",
          tabId: state.activeTabId,
          insertIndex: target,
        });
        return;
      }
      case "switch_tab":
        selectTab(index ?? 0);
        return;
      case "close_tab":
        if (
          config.ui.confirm_close &&
          activeWorkspace &&
          activeWorkspace.tabs.length === 1
        ) {
          setConfirm({
            message: "Close the last tab? This closes the workspace.",
            onConfirm: closeActiveTab,
          });
        } else {
          closeActiveTab();
        }
        return;
      case "rename_pane":
        setRenameMode("pane");
        setRenameDraft(state.panes.find((pane) => pane.id === focusedPaneId)?.title ?? "");
        return;
      case "edit_scrollback":
        void connection.request({ type: "pane.edit_scrollback", paneId: focusedPaneId })
          .then((result) => {
            const paneId = (result as { paneId?: string }).paneId;
            if (paneId) {
              setPopup({ paneId, width: "100%", height: "100%", title: "scrollback" });
            }
          })
          .catch((error: unknown) => {
            setMessage(error instanceof Error ? error.message : String(error));
          });
        return;
      case "clear_pane":
        void connection.request({ type: "pane.clear", paneId: focusedPaneId });
        return;
      case "copy_mode":
        enterCopyMode();
        return;
      case "focus_pane_left":
      case "focus_pane_down":
      case "focus_pane_up":
      case "focus_pane_right":
        void connection.request({
          type: "pane.focus_direction",
          direction: action.slice("focus_pane_".length) as "left",
        });
        return;
      case "swap_pane_left":
      case "swap_pane_down":
      case "swap_pane_up":
      case "swap_pane_right":
        void connection.request({
          type: "pane.swap",
          direction: action.slice("swap_pane_".length) as "left",
        });
        return;
      case "cycle_pane_next":
        focusOffset(1);
        return;
      case "cycle_pane_previous":
        focusOffset(-1);
        return;
      case "last_pane": {
        const previous = lastFocus.current.previous;
        if (previous && state.panes.some((pane) => pane.id === previous)) {
          void connection.request({ type: "pane.focus", paneId: previous });
        }
        return;
      }
      case "split_vertical":
      case "split_horizontal":
        void runAction(
          () => connection.request({
            type: "pane.create",
            direction: action === "split_vertical" ? "right" : "down",
          }),
          action === "split_vertical" ? "split right" : "split down",
        );
        return;
      case "close_pane":
        void runAction(
          () => connection.request({ type: "pane.close", paneId: focusedPaneId }),
          "pane closed",
        );
        return;
      case "zoom":
        void runAction(
          () => connection.request({ type: "pane.zoom", paneId: focusedPaneId }),
          "pane zoom toggled",
        );
        return;
      case "resize_mode":
        setMode("resize");
        return;
      case "resize_pane_left":
      case "resize_pane_down":
      case "resize_pane_up":
      case "resize_pane_right":
        void connection.request({
          type: "pane.resize",
          direction: action.slice("resize_pane_".length) as "left",
        });
        return;
      case "toggle_sidebar":
        setSidebarCollapsed((collapsed) => !collapsed);
        return;
      case "plugin_actions":
        if (pluginActions.length === 0) {
          setMessage("no enabled plugin actions");
          return;
        }
        setSelectedPluginAction(0);
        setPluginPickerOpen(true);
        return;
      case "refresh_machines":
        setMessage("checking machines…");
        void refreshMachines();
        return;
      case "remote_agents":
        if (remoteAgents.length === 0) {
          setMessage("no reachable remote agents; refresh machines first");
          return;
        }
        setSelectedRemoteAgent(0);
        setRemoteOutput("");
        setRemoteMode("picker");
        return;
      case "remote_panes":
        if (remotePanes.length === 0) {
          setMessage("no remote panes; refresh machines first");
          return;
        }
        setSelectedRemotePane(0);
        setRemotePaneOutput("");
        setRemotePaneMode("picker");
        return;
      case "remote_dashboard":
        if (remotePanes.length === 0) {
          setMessage("no remote panes; refresh machines first");
          return;
        }
        setRemoteScope(null);
        setRemoteDashboardOpen(true);
        return;
      default: {
        // Every action has a case; this fails to compile if one is added
        // without being handled.
        const unhandled: never = action;
        void unhandled;
      }
    }
  };

  const runCustomCommand = (index: number) => {
    const command = config.keys.commands[index];
    if (!command) return;
    if (command.type === "plugin_action") {
      const [pluginId, actionId] = command.command.split(/[.:](?=[^.:]*$)/);
      if (!pluginId || !actionId) {
        setMessage(`plugin action should look like plugin.action: ${command.command}`);
        return;
      }
      void runAction(
        () => connection.request({ type: "plugin.action-invoke", pluginId, actionId }, 35_000),
        `${command.command} invoked`,
      );
      return;
    }
    if (command.type === "popup") {
      void connection.request({
        type: "command.run",
        command: command.command,
        commandType: "popup",
      }).then((result) => {
        const paneId = (result as { paneId?: string }).paneId;
        if (paneId) {
          setPopup({
            paneId,
            width: command.width,
            height: command.height,
            title: command.description || command.command,
          });
        }
      }).catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    void runAction(
      () => connection.request({
        type: "command.run",
        command: command.command,
        commandType: command.type === "shell" ? "shell" : "pane",
      }),
      command.description || command.command,
    );
  };

  const enterCopyMode = () => {
    if (!state) return;
    const paneId = state.focusedPaneId;
    const surface = surfaces[paneId];
    void refreshCopyText(paneId).then((text) => {
      const top = viewTop(surface);
      const cursor = surface?.cursor && surface.cursor.visible
        ? { line: top + surface.cursor.y, col: surface.cursor.x }
        : { line: Math.max(0, text.total - 1), col: 0 };
      setCopyState({ paneId, cursor, anchor: null, lineMode: false, search: null });
      setMode("copy");
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  };

  const modeBarRow = (): ChromeRow => {
    const base = { color: theme.muted, backgroundColor: theme.panelBg };
    const key = (text: string): Segment => ({
      text,
      color: theme.brand,
      bold: true,
      backgroundColor: theme.panelBg,
    });
    const plain = (text: string): Segment => ({ text, ...base });
    const badge = (text: string, background = theme.brand): Segment => ({
      text,
      color: theme.panelContrast,
      backgroundColor: background,
      bold: true,
    });
    const shortcut = (action: Action) =>
      (keymap.labels.get(action)?.[0] ?? "").replace(/^prefix\+/, "");
    let segments: Segment[];
    if (mode === "prefix") {
      segments = [
        badge(" PREFIX "), plain(" "), key("esc"), plain(" cancel  "),
        key(keymap.prefix), plain(" send prefix  "),
        key(shortcut("toggle_agent_sort")), plain(" agents  "),
        key(shortcut("workspace_picker")), plain(" workspace nav  "),
        key(shortcut("help")), plain(" keybinds"),
      ];
    } else if (mode === "navigate") {
      segments = [
        badge(" NAVIGATE "), plain(" esc back  "), key("↑/↓"), plain(" workspace  "),
        key("tab"), plain(" pane  "), key(shortcut("help")), plain(" keybinds"),
      ];
    } else if (mode === "resize") {
      segments = [
        badge(" RESIZE ", theme.purple), plain("  "), key("h/l"), plain(" width  "),
        key("j/k"), plain(" height  "), key("esc"), plain(" done"),
      ];
    } else if (mode === "copy") {
      if (searchPrompt) {
        segments = [
          badge(" COPY "), plain(" "),
          key(searchPrompt.direction === "forward" ? "/" : "?"),
          { text: searchPrompt.text, color: theme.text, backgroundColor: theme.panelBg },
          { text: " ", backgroundColor: theme.text },
          plain("  enter search  esc cancel"),
        ];
      } else {
        const active = Boolean(copyState?.anchor || copyState?.search);
        segments = [
          badge(" COPY "), plain(" "), key("h/j/k/l w/b/e { }"), plain(" move  "),
          key("/ ?"), plain(" search  "), key("n/N"), plain(" repeat  "),
          key("v/space"), plain(copyState?.anchor ? " selecting  " : " select  "),
          key("y/enter"), plain(" copy  "),
          ...(active ? [key("esc"), plain(" clear  q exit")] : [key("q/esc"), plain(" exit")]),
        ];
      }
    } else {
      segments = [plain(` ${message}`)];
    }
    return { segments, background: theme.panelBg };
  };

  if (!state || !activeWorkspace || !activeTab) {
    return (
      <Box
        width={columns}
        height={rows}
        alignItems="center"
        justifyContent="center"
        borderStyle="round"
        borderColor={theme.border}
      >
        <Text color={theme.brand} bold>
          connecting to Shepherd…
        </Text>
      </Box>
    );
  }

  const paneById = new Map(state.panes.map((pane) => [pane.id, pane]));

  return (
    <Box flexDirection="row" width={columns} height={rows} backgroundColor={theme.background}>
      <Sidebar rows={sidebarModel} width={screen.sidebar.width} />
      <Box flexDirection="column" width={mainWidth} height={rows}>
      {mobileHeader.map((row, index) => (
        <ChromeLine key={`header-${index}`} row={row} width={mainWidth} />
      ))}
      {screen.tabBar && screen.tabBar.y === 0 && tabBarModel && (
        <ChromeLine row={tabBarModel} width={mainWidth} />
      )}
      {remoteDashboardOpen ? (
        <RemoteDashboard
          panes={dashboardPanes}
          title={dashboardTitle}
          tiles={remotePaneTiles}
          width={mainWidth}
          height={mainHeight}
        />
      ) : remotePaneMode ? (
        <Box
          width={mainWidth}
          height={mainHeight}
          justifyContent="center"
          alignItems="center"
          borderStyle="round"
          borderColor={theme.brand}
          backgroundColor={theme.surface}
          overflow="hidden"
        >
          <Box flexDirection="column" width={Math.min(88, columns - 8)}>
            {remotePaneMode === "picker" ? (
              <>
                <Text color={theme.brand} bold>
                  remote pane surfaces
                </Text>
                {remotePanes.map((pane, index) => (
                  <Text
                    key={`${pane.machineId}:${pane.paneId}`}
                    color={index === selectedRemotePane
                      ? theme.background
                      : theme.text}
                    backgroundColor={index === selectedRemotePane
                      ? theme.brand
                      : undefined}
                  >
                    {index === selectedRemotePane ? "▸ " : "  "}
                    {pane.title}@{pane.machineLabel} · {pane.status}
                  </Text>
                ))}
                <Text color={theme.muted}>
                  ↑/↓ select · Enter read · Esc close
                </Text>
              </>
            ) : remotePaneMode === "view" ? (
              <>
                <Text color={theme.brand} bold>
                  {remotePanes[selectedRemotePane]?.title ?? "remote pane"}
                  @{remotePanes[selectedRemotePane]?.machineLabel ?? "machine"}
                </Text>
                <Box flexDirection="column">
                  {remotePaneOutput.split("\n").slice(-14).map((line, index) => (
                    <Text key={index} wrap="truncate-end">
                      {line.length ? line : " "}
                    </Text>
                  ))}
                </Box>
                <Text color={theme.muted}>
                  Enter input · Esc choose another surface
                </Text>
              </>
            ) : (
              <>
                <Text color={theme.brand} bold>
                  remote pane input
                </Text>
                <Text color={theme.primary}>
                  {remotePaneInput.length ? remotePaneInput : " "}
                  <Text color={theme.brand}>▏</Text>
                </Text>
                <Text color={theme.muted}>Enter send · Esc cancel</Text>
              </>
            )}
          </Box>
        </Box>
      ) : remoteMode ? (
        <Box
          width={mainWidth}
          height={mainHeight}
          justifyContent="center"
          alignItems="center"
          borderStyle="round"
          borderColor={theme.cyan}
          backgroundColor={theme.surface}
          overflow="hidden"
        >
          <Box flexDirection="column" width={Math.min(84, columns - 8)}>
            {remoteMode === "picker" ? (
              <>
                <Text color={theme.cyan} bold>
                  remote agents
                </Text>
                {remoteAgents.map((agent, index) => (
                  <Text
                    key={`${agent.machineId}:${agent.paneId}`}
                    color={index === selectedRemoteAgent
                      ? theme.background
                      : theme.text}
                    backgroundColor={index === selectedRemoteAgent
                      ? theme.cyan
                      : undefined}
                  >
                    {index === selectedRemoteAgent ? "▸ " : "  "}
                    {agent.agent}@{agent.machineLabel} · {agent.status}
                  </Text>
                ))}
                <Text color={theme.muted}>
                  ↑/↓ select · Enter read · Esc close
                </Text>
              </>
            ) : remoteMode === "read" ? (
              <>
                <Text color={theme.cyan} bold>
                  {remoteAgents[selectedRemoteAgent]?.agent ?? "remote agent"}
                  @{remoteAgents[selectedRemoteAgent]?.machineLabel ?? "machine"}
                </Text>
                <Box flexDirection="column">
                  {remoteOutput.split("\n").slice(-12).map((line, index) => (
                    <Text key={index} wrap="truncate-end">
                      {line.length ? line : " "}
                    </Text>
                  ))}
                </Box>
                <Text color={theme.muted}>
                  Enter prompt · Esc choose another agent
                </Text>
              </>
            ) : (
              <>
                <Text color={theme.cyan} bold>
                  prompt remote agent
                </Text>
                <Text color={theme.primary}>
                  {remotePrompt.length ? remotePrompt : " "}
                  <Text color={theme.cyan}>▏</Text>
                </Text>
                <Text color={theme.muted}>Enter send · Esc cancel</Text>
              </>
            )}
          </Box>
        </Box>
      ) : pluginPickerOpen ? (
        <Box
          width={mainWidth}
          height={mainHeight}
          justifyContent="center"
          alignItems="center"
          borderStyle="round"
          borderColor={theme.purple}
          backgroundColor={theme.surface}
          overflow="hidden"
        >
          <Box flexDirection="column" width={Math.min(76, columns - 8)}>
            <Text color={theme.purple} bold>
              plugin actions
            </Text>
            {pluginActions.map((action, index) => (
              <Text
                key={action.label}
                color={index === selectedPluginAction
                  ? theme.background
                  : theme.text}
                backgroundColor={index === selectedPluginAction
                  ? theme.purple
                  : undefined}
              >
                {index === selectedPluginAction ? "▸ " : "  "}
                {action.label} — {action.title}
              </Text>
            ))}
            <Text color={theme.muted}>
              ↑/↓ select · Enter invoke · Esc close
            </Text>
          </Box>
        </Box>
      ) : helpOpen ? (
        <HelpOverlay
          keymap={keymap}
          filter={helpFilter}
          width={mainWidth}
          height={mainHeight}
        />
      ) : confirm ? (
        <ConfirmOverlay message={confirm.message} width={mainWidth} height={mainHeight} />
      ) : renameMode ? (
        <Box
          width={mainWidth}
          height={mainHeight}
          alignItems="center"
          justifyContent="center"
          borderStyle="round"
          borderColor={theme.purple}
          backgroundColor={theme.surface}
        >
          <Box flexDirection="column" gap={1}>
            <Text color={theme.purple} bold>
              {RENAME_TITLES[renameMode]}
            </Text>
            <FieldText field={renameField} />
            <Text color={theme.muted}>Enter save · Esc cancel</Text>
          </Box>
        </Box>
      ) : (
        <Box width={mainWidth} height={mainHeight} overflow="hidden">
          {geometries.map((geometry) => {
            const pane = paneById.get(geometry.paneId);
            if (!pane) return null;
            const surface = surfaces[pane.id];
            const chrome = chromeFor(pane.id);
            return (
              <Box
                key={pane.id}
                position="absolute"
                marginLeft={geometry.rect.x - screen.main.x}
                marginTop={geometry.rect.y - screen.main.y}
              >
                <TerminalPane
                  pane={pane}
                  focused={pane.id === state.focusedPaneId}
                  width={geometry.rect.width}
                  height={geometry.rect.height}
                  lines={surface?.lines ?? EMPTY_LINES}
                  label={pane.metadataTitle || pane.title ||
                    (config.ui.show_agent_labels_on_pane_borders
                      ? pane.displayAgent || pane.agent || ""
                      : "")}
                  frame={frames.get(pane.id)}
                  scrollbar={chrome.scrollbar
                    ? surface?.scroll ?? { offsetFromBottom: 0, maxOffsetFromBottom: 0 }
                    : null}
                  viewTop={viewTop(surface)}
                  copyCursor={copyState?.paneId === pane.id
                    ? copyState.cursor
                    : undefined}
                  selection={terminalSelection?.paneId === pane.id
                    ? terminalSelection
                    : undefined}
                />
              </Box>
            );
          })}
        </Box>
      )}
      {screen.tabBar && screen.tabBar.y !== 0 && tabBarModel && (
        <ChromeLine row={tabBarModel} width={mainWidth} />
      )}
      </Box>

      {switcher && !overlayOpen && (
        <Box
          position="absolute"
          flexDirection="column"
          width={columns}
          height={rows}
          backgroundColor={theme.panelBg ?? theme.background}
        >
          {switcher.rows.map((row, index) => (
            <ChromeLine key={index} row={row} width={columns} />
          ))}
        </Box>
      )}
      {(mode !== "terminal" || message) && !overlayOpen && !switcher && (
        <Box
          position="absolute"
          marginLeft={screen.modeBar.x}
          marginTop={screen.modeBar.y}
          width={screen.modeBar.width}
          height={1}
        >
          <ChromeLine row={modeBarRow()} width={screen.modeBar.width} />
        </Box>
      )}
      {navigator && (
        <NavigatorOverlay
          state={state}
          navigator={navigator}
          columns={columns}
          rows={rows}
          indicators={config.ui.status_indicators}
        />
      )}
      {settings && (
        <SettingsOverlay settings={settings} config={config} columns={columns} rows={rows} />
      )}
      {menu && <MenuOverlay menu={menu} columns={columns} rows={rows} />}
      {dragPreview && <DragPreview drag={dragPreview} columns={columns} rows={rows} />}
      {popup && popupRect && (
        <Panel rect={popupRect} title={popup.title}>
          <TerminalPane
            pane={{
              id: popup.paneId,
              title: "",
              command: null,
              cwd: "",
              agent: null,
              status: "unknown",
              exitCode: null,
              updatedAt: "",
            }}
            focused
            width={popupRect.width - 2}
            height={popupRect.height - 2}
            lines={popupSurface?.lines ?? EMPTY_LINES}
            bordered={false}
          />
        </Panel>
      )}
      {toasts.length > 0 && (
        <ToastStack toasts={toasts} columns={columns} rows={rows} />
      )}
    </Box>
  );
}

const EMPTY_LINES: TerminalLine[] = [];

/** Opens a URL on the machine the user is sitting at. */
function openUrl(url: string): void {
  if (!/^(https?|file|mailto):/i.test(url)) return;
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "explorer"
      : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

function applySettingInMemory(config: ShepherdConfig, option: SettingsOption): void {
  if (option.section === "theme") config.theme.name = String(option.value);
  else if (option.key === "status_indicators") {
    config.ui.status_indicators = option.value as "dots" | "symbols";
  } else if (option.section === "ui.sound") config.ui.sound.enabled = Boolean(option.value);
  else if (option.section === "ui.toast") {
    config.ui.toast.delivery = option.value as ShepherdConfig["ui"]["toast"]["delivery"];
  }
}

/** Popup size from `[[keys.command]]` width/height: cells or "80%". */
export function popupSize(value: string, total: number): number {
  const percent = /^(\d{1,3})%$/.exec(value.trim());
  if (percent) return Math.max(10, Math.floor((total * Number(percent[1])) / 100));
  const cells = Number.parseInt(value, 10);
  return Number.isFinite(cells) && cells > 0 ? Math.min(total, cells) : Math.floor(total * 0.8);
}

interface Notice {
  title: string;
  context: string;
  paneId: string | null;
  agent?: string;
  sound: "done" | "request" | null;
}

/** A text field with its cursor drawn as an inverted cell. */
function FieldText({ field }: { field: TextField }) {
  const [before, at, after] = fieldParts(field);
  return (
    <Text color={theme.primary}>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}

/** Shepherd's `ui.window_title` template: {hostname}, {workspace}, {tab},
 * {pane}, {terminal_title}; `{{` and `}}` are literal braces. */
export function renderWindowTitle(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{|\}\}|\{(\w+)\}/g, (match, name: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    return name !== undefined && name in values ? values[name] ?? "" : match;
  }).replace(/[\x00-\x1f\x7f]/g, "");
}

function copySelectionOf(copy: {
  paneId: string;
  cursor: CopyPosition;
  anchor: CopyPosition | null;
  lineMode: boolean;
}): TextSelection {
  const anchor = copy.anchor ?? copy.cursor;
  return {
    paneId: copy.paneId,
    anchor: { col: anchor.col, row: anchor.line },
    head: { col: copy.cursor.col, row: copy.cursor.line },
    mode: copy.lineMode ? "line" : "char",
  };
}

const RENAME_TITLES: Record<string, string> = {
  pane: "rename pane",
  tab: "rename tab",
  workspace: "rename workspace",
  "new-tab": "new tab name",
  "new-workspace": "new workspace name",
  "new-worktree": "new worktree branch",
};

const MODE_COLORS: Record<Mode, () => string> = {
  terminal: () => theme.muted,
  prefix: () => theme.warning,
  navigate: () => theme.purple,
  resize: () => theme.cyan,
  copy: () => theme.success,
};

const MODE_HINTS: Record<Mode, string> = {
  terminal: "",
  prefix: "waiting for a key · esc cancel",
  navigate: "↑/↓ workspace · enter open · h/j/k/l pane · esc exit",
  resize: "h/j/k/l or arrows resize · esc/enter done",
  copy: "hjkl move · v/V select · y copy · / ? search · q exit",
};

/** Direction for a movement key: h/j/k/l style letters or arrows. */
function navDirection(
  press: KeyPress,
  letters: Record<"left" | "down" | "up" | "right", string>,
): "left" | "down" | "up" | "right" | null {
  if (press.ctrl || press.alt) return null;
  for (const direction of ["left", "down", "up", "right"] as const) {
    if (press.name === direction || press.name === letters[direction]) {
      return direction;
    }
  }
  return null;
}

function RemoteDashboard({
  panes,
  tiles,
  title,
  width,
  height,
}: {
  panes: Array<{
    machineId: string;
    machineLabel: string;
    paneId: string;
    title: string;
    agent: string | null;
    status: import("../types.js").AgentStatus;
  }>;
  tiles: Record<string, TerminalLine[]>;
  title: string;
  width: number;
  height: number;
}) {
  const tileWidth = Math.max(20, Math.floor(width / 2));
  const tileHeight = Math.max(7, Math.floor((height - 2) / 2));
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={theme.brand} bold>
          {title}
        </Text>
        <Text color={theme.muted}>Esc close</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" width={width} height={height - 1} gap={0}>
        {panes.map((pane) => (
          <TerminalPane
            key={`${pane.machineId}:${pane.paneId}`}
            pane={{
              id: `${pane.machineId}:${pane.paneId}`,
              title: `${pane.title}@${pane.machineLabel}`,
              command: null,
              cwd: "",
              agent: pane.agent,
              status: pane.status,
              exitCode: null,
              updatedAt: "",
            }}
            focused={false}
            width={tileWidth}
            height={tileHeight}
            lines={tiles[`${pane.machineId}:${pane.paneId}`] ?? []}
          />
        ))}
      </Box>
    </Box>
  );
}
