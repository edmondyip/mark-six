import { BallColorKind, getBallColorKind } from "../balls/BallPhysicsSystem";
import type { CameraPresetId } from "../camera/CameraDirector";
import {
  DrawHistoryEntry,
  DrawnBallItem,
  PrizeEvaluation,
  evaluateMarkSixPrize,
  generateQuickPick,
  loadDrawHistory,
  saveDrawHistory,
} from "./markSixTicket";
import { WinCelebrationFx } from "./winCelebrationFx";

export interface HUDCallbacks {
  onStartDraw: () => void;
  onResetDraw: () => void;
  onToggleFastMode: (enabled: boolean) => void;
  onToggleDirector: (enabled: boolean) => void;
  onToggleAudio: (enabled: boolean) => void;
  onSelectCamera: (cam: CameraPresetId) => void;
  onPrizeWin?: (tier: number) => void;
}

export class BroadcastHUD {
  private readonly callbacks: HUDCallbacks;
  private readonly phaseBadge = document.getElementById("phase-badge")!;
  private readonly clockEl = document.getElementById("live-clock")!;
  private readonly heroPopup = document.getElementById("hero-popup")!;
  private readonly heroBallCircle = document.getElementById("hero-ball-circle")!;
  private readonly heroBallNum = document.getElementById("hero-ball-num")!;
  private readonly heroLabel = document.getElementById("hero-label")!;
  private readonly camChip = document.getElementById("cam-status-chip");

  private readonly btnStart = document.getElementById("btn-start") as HTMLButtonElement;
  private readonly btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
  private readonly btnSpeed = document.getElementById("btn-speed") as HTMLButtonElement;
  private readonly btnDirector = document.getElementById("btn-director") as HTMLButtonElement;
  private readonly btnAudio = document.getElementById("btn-audio") as HTMLButtonElement;

  private readonly speedStateEl = document.getElementById("speed-state");
  private readonly directorStateEl = document.getElementById("director-state");
  private readonly audioStateEl = document.getElementById("audio-state");

  // Win celebration elements
  private readonly jackpotAura = document.getElementById("jackpot-aura")!;
  private readonly winBanner = document.getElementById("win-banner")!;
  private readonly winBannerIcon = document.getElementById("win-banner-icon")!;
  private readonly winBannerTitle = document.getElementById("win-banner-title")!;
  private readonly winBannerSub = document.getElementById("win-banner-sub")!;
  private readonly btnCloseWinBanner = document.getElementById("btn-close-win-banner") as HTMLButtonElement;
  private readonly winFx: WinCelebrationFx | null;

  // Scoreboard My-Pick bar + floating 7x7 picker
  private readonly btnOpenTicket = document.getElementById("btn-open-ticket") as HTMLButtonElement;
  private readonly ticketSelectedRow = document.getElementById("ticket-selected-row")!;
  private readonly ticketPickedBalls = document.getElementById("ticket-picked-balls")!;
  private readonly prizePill = document.getElementById("ticket-prize-pill")!;
  private readonly btnEditTicket = document.getElementById("btn-edit-ticket") as HTMLButtonElement;
  private readonly btnDropTicket = document.getElementById("btn-drop-ticket") as HTMLButtonElement;

  private readonly ticketPanel = document.getElementById("ticket-panel")!;
  private readonly ticketGrid = document.getElementById("ticket-grid")!;
  private readonly ticketCountBadge = document.getElementById("ticket-count-badge")!;
  private readonly ticketEvalBar = document.getElementById("ticket-eval-bar")!;
  private readonly btnQuickPick = document.getElementById("btn-quick-pick") as HTMLButtonElement;
  private readonly btnClearPick = document.getElementById("btn-clear-pick") as HTMLButtonElement;
  private readonly btnCloseTicket = document.getElementById("btn-close-ticket") as HTMLButtonElement;

  // Right-edge vertical draw history rail
  private readonly historyRail = document.getElementById("history-rail")!;
  private readonly historyList = document.getElementById("history-list")!;
  private readonly historyCountBadge = document.getElementById("history-count-badge")!;
  private readonly btnClearHistory = document.getElementById("btn-clear-history") as HTMLButtonElement;
  private readonly btnToggleHistory = document.getElementById("btn-toggle-history") as HTMLButtonElement;

  // Mobile-only collapsible dock controls
  private readonly isMobile: boolean;
  private readonly bottomDock = document.getElementById("bottom-dock")!;
  private readonly btnMobileTicket = document.getElementById("btn-mobile-ticket") as HTMLButtonElement | null;
  private readonly btnMobileHistory = document.getElementById("btn-mobile-history") as HTMLButtonElement | null;
  private readonly btnMobileDrawer = document.getElementById("btn-mobile-drawer") as HTMLButtonElement | null;
  private readonly btnCloseMobileDrawer = document.getElementById("btn-close-mobile-drawer") as HTMLButtonElement | null;
  private readonly mobileTicketBadge = document.getElementById("mobile-ticket-badge");
  private readonly mobileHistoryBadge = document.getElementById("mobile-history-badge");
  private readonly canvasContainer = document.getElementById("canvas-container");

  private readonly camButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".btn-cam"),
  );
  private readonly slots = Array.from({ length: 7 }, (_, i) =>
    document.getElementById(`slot-${i}`)!,
  );

  private readonly ticketButtons = new Map<number, HTMLButtonElement>();
  private readonly pickedNums = new Set<number>();
  private drawnSlots: Array<DrawnBallItem | null> = Array(7).fill(null);
  private historyEntries: DrawHistoryEntry[] = loadDrawHistory();

  private drawSettled = false;
  private activeWinTier = 0;
  private fastModeOn = false;
  private directorOn = true;
  private audioOn = true;
  private historyCollapsed = true;
  private clockTimer: number | null = null;
  private winBannerTimer: number | null = null;

  private readonly onCanvasPointerDown = (): void => {
    if (this.isMobile) {
      this.closeAllMobilePanels();
    }
  };

  constructor(
    callbacks: HUDCallbacks,
    isMobile = document.body.classList.contains("is-mobile"),
  ) {
    this.callbacks = callbacks;
    this.isMobile = isMobile;
    const fxCanvas = document.getElementById("win-fx-canvas") as HTMLCanvasElement | null;
    this.winFx = fxCanvas ? new WinCelebrationFx(fxCanvas) : null;

    this.btnStart.addEventListener("click", () => {
      if (this.isMobile) {
        this.closeAllMobilePanels();
      }
      callbacks.onStartDraw();
    });
    this.btnReset.addEventListener("click", () => callbacks.onResetDraw());
    this.btnCloseWinBanner.addEventListener("click", () => this.clearWinCelebration());

    this.btnSpeed.addEventListener("click", () => {
      this.fastModeOn = !this.fastModeOn;
      this.btnSpeed.classList.toggle("active", this.fastModeOn);
      if (this.speedStateEl) {
        this.speedStateEl.textContent = this.fastModeOn ? "開" : "關";
      }
      callbacks.onToggleFastMode(this.fastModeOn);
    });

    this.btnDirector.addEventListener("click", () => {
      this.directorOn = !this.directorOn;
      this.btnDirector.classList.toggle("active", this.directorOn);
      if (this.directorStateEl) {
        this.directorStateEl.textContent = this.directorOn ? "開" : "關";
      }
      callbacks.onToggleDirector(this.directorOn);
    });

    this.btnAudio.addEventListener("click", () => {
      this.audioOn = !this.audioOn;
      this.btnAudio.classList.toggle("active", this.audioOn);
      if (this.audioStateEl) {
        this.audioStateEl.textContent = this.audioOn ? "開" : "關";
      }
      callbacks.onToggleAudio(this.audioOn);
    });

    this.btnOpenTicket.addEventListener("click", () => this.setTicketPanelOpen(true));
    this.btnEditTicket.addEventListener("click", () =>
      this.setTicketPanelOpen(this.ticketPanel.classList.contains("hidden")),
    );
    this.btnCloseTicket.addEventListener("click", () => this.setTicketPanelOpen(false));
    this.btnDropTicket.addEventListener("click", () => {
      this.pickedNums.clear();
      this.clearWinCelebration();
      this.refreshTicketAndPrizes();
    });

    this.btnQuickPick.addEventListener("click", () => {
      this.pickedNums.clear();
      for (const n of generateQuickPick()) {
        this.pickedNums.add(n);
      }
      this.refreshTicketAndPrizes(true);
    });

    this.btnClearPick.addEventListener("click", () => {
      this.pickedNums.clear();
      this.clearWinCelebration();
      this.refreshTicketAndPrizes();
    });

    this.btnClearHistory.addEventListener("click", () => {
      this.historyEntries = [];
      saveDrawHistory(this.historyEntries);
      this.renderHistoryList();
    });

    if (!this.isMobile) {
      this.historyRail.classList.toggle("collapsed", this.historyCollapsed);
      this.btnToggleHistory.textContent = this.historyCollapsed ? "+" : "−";
    }

    this.btnToggleHistory.addEventListener("click", () => {
      if (this.isMobile) {
        this.setMobileHistoryOpen(false);
        return;
      }
      this.historyCollapsed = !this.historyCollapsed;
      this.historyRail.classList.toggle("collapsed", this.historyCollapsed);
      this.btnToggleHistory.textContent = this.historyCollapsed ? "+" : "−";
    });

    if (this.isMobile) {
      this.btnToggleHistory.textContent = "✕";
      this.btnMobileTicket?.addEventListener("click", () => {
        const isOpen = !this.ticketPanel.classList.contains("hidden");
        this.setTicketPanelOpen(!isOpen);
      });
      this.btnMobileHistory?.addEventListener("click", () => {
        const isOpen = this.historyRail.classList.contains("mobile-open");
        this.setMobileHistoryOpen(!isOpen);
      });
      this.btnMobileDrawer?.addEventListener("click", () => {
        const isOpen = this.bottomDock.classList.contains("mobile-drawer-open");
        this.setMobileDrawerOpen(!isOpen);
      });
      this.btnCloseMobileDrawer?.addEventListener("click", () => {
        this.setMobileDrawerOpen(false);
      });
      this.canvasContainer?.addEventListener("pointerdown", this.onCanvasPointerDown);
    }

    for (const btn of this.camButtons) {
      btn.addEventListener("click", () => {
        const cam = btn.dataset.cam as CameraPresetId | undefined;
        if (cam) {
          callbacks.onSelectCamera(cam);
          if (this.isMobile) {
            this.closeAllMobilePanels();
          }
        }
      });
    }

    this.buildTicketGrid();
    this.refreshTicketAndPrizes();
    this.renderHistoryList();
    this.startClock();
  }

  setRunningState(running: boolean): void {
    this.btnStart.disabled = running;
  }

  setPhaseText(text: string): void {
    this.phaseBadge.textContent = text;
  }

  setActiveCamera(cam: CameraPresetId, chipText: string): void {
    if (this.camChip) {
      this.camChip.textContent = chipText;
    }
    for (const btn of this.camButtons) {
      btn.classList.toggle("active", btn.dataset.cam === cam);
    }
  }

  showHeroBall(
    num: number,
    color: BallColorKind,
    drawIndex: number,
    visible: boolean,
  ): void {
    if (!visible || num <= 0) {
      this.heroPopup.classList.add("hidden");
      return;
    }

    const isSpecial = drawIndex === 6;
    this.heroPopup.classList.remove("hidden");
    this.heroBallCircle.className = `hero-ball-circle ball-${color}`;
    this.heroBallNum.textContent = String(num).padStart(2, "0");
    this.heroLabel.textContent = isSpecial
      ? "特別號碼 EXTRA NUMBER"
      : `第 ${drawIndex + 1} 個中獎號碼`;
  }

  revealSlot(drawIndex: number, num: number, color: BallColorKind): void {
    if (drawIndex < 0 || drawIndex >= 7) return;
    this.drawnSlots[drawIndex] = { num, color };
    this.refreshTicketAndPrizes();
  }

  /** Sorts slots 1..6 ascending, saves to history, fires celebration FX on win, and returns winning tier (0 if none). */
  recordCompletedDraw(drawn: DrawnBallItem[]): number {
    this.drawSettled = true;
    const sortedMain = drawn.slice(0, 6).sort((a, b) => a.num - b.num);
    const special = drawn[6] ?? null;
    const orderedResult = special ? [...sortedMain, special] : sortedMain;

    for (let i = 0; i < 6; i++) {
      this.drawnSlots[i] = sortedMain[i] ?? null;
    }
    this.drawnSlots[6] = special;

    const mainNums = sortedMain.map((d) => d.num);
    const evaluation = evaluateMarkSixPrize(
      this.pickedNums,
      mainNums,
      special ? special.num : null,
    );

    const entry: DrawHistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString("en-GB", { hour12: false }),
      balls: orderedResult.map((d) => ({ num: d.num, color: d.color })),
      prizeSummary: evaluation ? evaluation.label : undefined,
    };
    this.historyEntries = [entry, ...this.historyEntries].slice(0, 10);
    saveDrawHistory(this.historyEntries);
    this.renderHistoryList();
    this.refreshTicketAndPrizes();

    if (evaluation && evaluation.tier >= 1) {
      this.triggerWinCelebration(evaluation);
      return evaluation.tier;
    }
    return 0;
  }

  resetSlots(): void {
    this.drawSettled = false;
    this.drawnSlots = Array(7).fill(null);
    this.clearWinCelebration();
    this.refreshTicketAndPrizes();
    this.showHeroBall(0, "red", 0, false);
    this.setRunningState(false);
  }

  dispose(): void {
    if (this.clockTimer !== null) {
      window.clearInterval(this.clockTimer);
    }
    if (this.winBannerTimer !== null) {
      window.clearTimeout(this.winBannerTimer);
    }
    this.canvasContainer?.removeEventListener("pointerdown", this.onCanvasPointerDown);
    this.winFx?.dispose();
  }

  private setTicketPanelOpen(open: boolean): void {
    this.ticketPanel.classList.toggle("hidden", !open);
    if (this.isMobile) {
      this.btnMobileTicket?.classList.toggle("active", open);
      this.btnMobileTicket?.setAttribute("aria-expanded", String(open));
      if (open) {
        this.setMobileHistoryOpen(false);
        this.setMobileDrawerOpen(false);
      }
    }
  }

  private setMobileHistoryOpen(open: boolean): void {
    this.historyRail.classList.toggle("mobile-open", open);
    this.btnMobileHistory?.classList.toggle("active", open);
    this.btnMobileHistory?.setAttribute("aria-expanded", String(open));
    if (open) {
      this.setTicketPanelOpen(false);
      this.setMobileDrawerOpen(false);
    }
  }

  private setMobileDrawerOpen(open: boolean): void {
    this.bottomDock.classList.toggle("mobile-drawer-open", open);
    this.btnMobileDrawer?.classList.toggle("active", open);
    this.btnMobileDrawer?.setAttribute("aria-expanded", String(open));
    if (open) {
      this.setTicketPanelOpen(false);
      this.setMobileHistoryOpen(false);
    }
  }

  private closeAllMobilePanels(): void {
    this.setTicketPanelOpen(false);
    this.setMobileHistoryOpen(false);
    this.setMobileDrawerOpen(false);
  }

  private buildTicketGrid(): void {
    const frag = document.createDocumentFragment();
    for (let num = 1; num <= 49; num++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `ticket-num-btn ball-${getBallColorKind(num)}`;
      btn.textContent = String(num).padStart(2, "0");
      btn.addEventListener("click", () => {
        if (this.pickedNums.has(num)) {
          this.pickedNums.delete(num);
          this.clearWinCelebration();
          this.refreshTicketAndPrizes();
        } else if (this.pickedNums.size < 6) {
          this.pickedNums.add(num);
          this.refreshTicketAndPrizes(this.pickedNums.size === 6);
        }
      });
      this.ticketButtons.set(num, btn);
      frag.appendChild(btn);
    }
    this.ticketGrid.appendChild(frag);
  }

  private renderSlots(): void {
    const mainRevealed = this.drawnSlots
      .slice(0, 6)
      .filter((d): d is DrawnBallItem => d !== null);
    const orderedMain = this.drawSettled
      ? [...mainRevealed].sort((a, b) => a.num - b.num)
      : mainRevealed;
    const hitClass =
      this.activeWinTier === 1 ? " matched jackpot-hit" : " matched";

    for (let i = 0; i < 6; i++) {
      const slot = this.slots[i];
      const item = orderedMain[i] ?? null;
      if (!item) {
        slot.className = "ball-slot empty";
        slot.innerHTML = `<span>${i + 1}</span>`;
      } else {
        const matched = this.pickedNums.size === 6 && this.pickedNums.has(item.num);
        slot.className = `ball-slot filled ball-${item.color}${matched ? hitClass : ""}`;
        slot.innerHTML = `<span>${String(item.num).padStart(2, "0")}</span>`;
      }
    }

    const specialSlot = this.slots[6];
    const specialItem = this.drawnSlots[6];
    if (!specialItem) {
      specialSlot.className = "ball-slot special empty";
      specialSlot.innerHTML = `<span>特</span>`;
    } else {
      const matched = this.pickedNums.size === 6 && this.pickedNums.has(specialItem.num);
      specialSlot.className = `ball-slot filled special ball-${specialItem.color}${matched ? hitClass : ""}`;
      specialSlot.innerHTML = `<span>${String(specialItem.num).padStart(2, "0")}</span>`;
    }
  }

  private refreshTicketAndPrizes(triggerIfSettledWin = false): void {
    const drawnSet = new Set<number>();
    const mainNums: number[] = [];
    for (let i = 0; i < 6; i++) {
      const item = this.drawnSlots[i];
      if (item) {
        drawnSet.add(item.num);
        mainNums.push(item.num);
      }
    }
    const specialNum = this.drawnSlots[6]?.num ?? null;
    if (specialNum !== null) drawnSet.add(specialNum);

    const evaluation = evaluateMarkSixPrize(this.pickedNums, mainNums, specialNum);
    this.activeWinTier = this.drawSettled && evaluation ? evaluation.tier : 0;

    this.ticketCountBadge.textContent = `${this.pickedNums.size}/6`;
    if (this.mobileTicketBadge) {
      if (this.drawSettled && evaluation && evaluation.tier > 0) {
        this.mobileTicketBadge.textContent = evaluation.label.split("（")[0];
      } else {
        this.mobileTicketBadge.textContent = `${this.pickedNums.size}/6`;
      }
    }
    this.btnMobileTicket?.classList.toggle("has-pick", this.pickedNums.size === 6);
    for (const [num, btn] of this.ticketButtons) {
      const selected = this.pickedNums.has(num);
      btn.classList.toggle("selected", selected);
      btn.classList.toggle("hit", selected && drawnSet.has(num));
    }

    const hasAnyPick = this.pickedNums.size > 0;
    this.btnOpenTicket.classList.toggle("hidden", hasAnyPick);
    this.ticketSelectedRow.classList.toggle("hidden", !hasAnyPick);

    if (hasAnyPick) {
      const sortedPicks = Array.from(this.pickedNums).sort((a, b) => a - b);
      const hitClass =
        this.activeWinTier === 1 ? " matched jackpot-hit" : " matched";
      this.ticketPickedBalls.innerHTML = sortedPicks
        .map((n) => {
          const hit = this.pickedNums.size === 6 && drawnSet.has(n);
          return `<span class="picked-ball ball-${getBallColorKind(n)}${hit ? hitClass : ""}">${String(n).padStart(2, "0")}</span>`;
        })
        .join("");
    } else {
      this.ticketPickedBalls.innerHTML = "";
    }

    if (this.pickedNums.size < 6) {
      this.ticketEvalBar.textContent =
        this.pickedNums.size === 0
          ? "請點選 6 個號碼或按「機選一注」"
          : `尚欠 ${6 - this.pickedNums.size} 個號碼即可自動對獎`;
      this.ticketEvalBar.className = "popover-footer";
      this.prizePill.className = "prize-pill hidden";
      this.prizePill.textContent = "";
    } else if (!evaluation) {
      const pickedStr = Array.from(this.pickedNums)
        .sort((a, b) => a - b)
        .map((n) => String(n).padStart(2, "0"))
        .join(" · ");
      this.ticketEvalBar.textContent = `已選：${pickedStr} · 開始攪珠即會即時對獎`;
      this.ticketEvalBar.className = "popover-footer";
      this.prizePill.className = "prize-pill hidden";
      this.prizePill.textContent = "";
    } else {
      this.ticketEvalBar.textContent = evaluation.label;
      this.ticketEvalBar.className = `popover-footer${evaluation.tier > 0 ? " win" : ""}`;
      const pillMod =
        evaluation.tier === 1
          ? " tier-jackpot"
          : evaluation.tier > 0
            ? " tier-win"
            : "";
      this.prizePill.className = `prize-pill${pillMod}`;
      this.prizePill.textContent = evaluation.label;

      if (triggerIfSettledWin && this.drawSettled && evaluation.tier >= 1) {
        this.triggerWinCelebration(evaluation);
        this.callbacks.onPrizeWin?.(evaluation.tier);
      }
    }

    this.renderSlots();
  }

  private triggerWinCelebration(evaluation: PrizeEvaluation): void {
    const isJackpot = evaluation.tier === 1;
    this.winFx?.trigger(evaluation.tier);

    this.jackpotAura.classList.toggle("hidden", !isJackpot);
    this.winBanner.className = `win-banner${isJackpot ? " jackpot" : ""}`;
    this.winBannerIcon.textContent = isJackpot ? "🏆" : evaluation.tier <= 3 ? "🎊" : "🎉";
    this.winBannerTitle.textContent = isJackpot
      ? "頭獎大獎！六個正碼全中！"
      : `恭喜中得 ${evaluation.label}`;
    this.winBannerSub.textContent = isJackpot
      ? "JACKPOT GRAND PRIZE · 金色星雨慶祝"
      : `已核對本局攪珠號碼（共中 ${evaluation.mainHits} 正碼${evaluation.specialHit ? "＋特碼" : ""}）`;

    if (this.winBannerTimer !== null) {
      window.clearTimeout(this.winBannerTimer);
    }
    this.winBannerTimer = window.setTimeout(
      () => {
        this.winBanner.classList.add("hidden");
        this.jackpotAura.classList.add("hidden");
      },
      isJackpot ? 6200 : 4200,
    );
  }

  private clearWinCelebration(): void {
    this.activeWinTier = 0;
    this.winFx?.clear();
    this.winBanner.classList.add("hidden");
    this.jackpotAura.classList.add("hidden");
    if (this.winBannerTimer !== null) {
      window.clearTimeout(this.winBannerTimer);
      this.winBannerTimer = null;
    }
  }

  private renderHistoryList(): void {
    this.historyCountBadge.textContent = `${this.historyEntries.length} 局`;
    if (this.mobileHistoryBadge) {
      this.mobileHistoryBadge.textContent = String(this.historyEntries.length);
    }
    if (this.historyEntries.length === 0) {
      this.historyList.innerHTML = `<div class="history-empty">完成攪珠後自動記錄</div>`;
      return;
    }

    this.historyList.innerHTML = this.historyEntries
      .map((entry) => {
        const orderedMain = [...entry.balls.slice(0, 6)].sort((a, b) => a.num - b.num);
        const mainHtml = orderedMain
          .map(
            (b) =>
              `<span class="mini-ball ball-${b.color}">${String(b.num).padStart(2, "0")}</span>`,
          )
          .join("");
        const spec = entry.balls[6];
        const specHtml = spec
          ? `<span class="history-plus">+</span><span class="mini-ball special ball-${spec.color}">${String(spec.num).padStart(2, "0")}</span>`
          : "";
        const prizeHtml = entry.prizeSummary
          ? `<span class="history-prize">${entry.prizeSummary}</span>`
          : "";
        return `<div class="history-row">
          <div class="history-meta">
            <span class="history-time">${entry.timestamp}</span>
            ${prizeHtml}
          </div>
          <div class="history-balls">${mainHtml}${specHtml}</div>
        </div>`;
      })
      .join("");
  }

  private startClock(): void {
    const updateClock = () => {
      const now = new Date();
      this.clockEl.textContent = now.toLocaleTimeString("en-GB", {
        hour12: false,
      });
    };
    updateClock();
    this.clockTimer = window.setInterval(updateClock, 1000);
  }
}
