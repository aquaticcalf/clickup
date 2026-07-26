import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, SettingsList, Spacer, Text, matchesKey, type Component, type SelectItem, type SettingItem } from "@earendil-works/pi-tui";
import type { IssueSummary, PullRequestSummary } from "./github.ts";
import type { PluginSettings } from "./index.ts";

export interface GithubMenuActions {
  listPullRequests(): Promise<PullRequestSummary[]>;
  checkoutPullRequest(number: number): Promise<void>;
  checkoutByNumber(number: number): Promise<void>;
  returnFromPullRequest(): Promise<void>;
  refreshPullRequests(): Promise<void>;
  showStatus(): Promise<string>;
  showPullRequest(number: number): Promise<string>;
  showDiff(number: number): Promise<string>;
  openPullRequest(number: number): Promise<void>;
  openRepository(): Promise<void>;
  showChecks(number?: number): Promise<string>;
  waitForChecks(number: number): Promise<string>;
  listIssues(query?: string): Promise<IssueSummary[]>;
  showIssue(number: number): Promise<string>;
  openIssue(number: number): Promise<void>;
  createPullRequest(): Promise<void>;
  pushCurrentBranch(): Promise<void>;
  editPullRequest(number: number): Promise<void>;
  commentOnPullRequest(number: number): Promise<void>;
  setPullRequestState(number: number, state: "close" | "reopen"): Promise<void>;
  markPullRequestReady(number: number): Promise<void>;
  mergePullRequest(number: number): Promise<void>;
  saveSettings(settings: PluginSettings): void;
}

interface MenuContext {
  ctx: ExtensionContext;
  settings: PluginSettings;
  actions: GithubMenuActions;
  tui: { requestRender(): void };
  done: () => void;
}

let currentTheme: ExtensionContext["ui"]["theme"];

function border(): DynamicBorder {
  return new DynamicBorder((text: string) => currentTheme.fg("accent", text));
}

class SettingsPanel extends Container {
  private readonly list: SettingsList;

  constructor(
    title: string,
    description: string,
    items: SettingItem[],
    onChange: (id: string, value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(border());
    this.addChild(new Text(currentTheme.fg("accent", currentTheme.bold(title)), 1, 0));
    this.addChild(new Text(currentTheme.fg("muted", description), 1, 0));
    this.addChild(new Spacer(1));
    this.list = new SettingsList(
      items,
      Math.min(Math.max(items.length, 8), 15),
      getSettingsListTheme(),
      onChange,
      onCancel,
      { enableSearch: true },
    );
    this.addChild(this.list);
    this.addChild(border());
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

class SelectPanel<T> extends Container {
  private selectList: SelectList | undefined;

  constructor(
    title: string,
    description: string,
    menu: MenuContext,
    load: () => Promise<T[]>,
    toItem: (item: T) => SelectItem,
    onSelect: (item: T) => Promise<void>,
  ) {
    super();
    this.addChild(border());
    this.addChild(new Text(currentTheme.fg("accent", currentTheme.bold(title)), 1, 0));
    this.addChild(new Text(currentTheme.fg("muted", description), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(currentTheme.fg("dim", "Loading…"), 1, 0));
    this.addChild(border());

    void load().then(async (items) => {
      this.clear();
      this.addChild(border());
      this.addChild(new Text(currentTheme.fg("accent", currentTheme.bold(title)), 1, 0));
      this.addChild(new Text(currentTheme.fg("muted", description), 1, 0));
      this.addChild(new Spacer(1));
      const mapped = items.map(toItem);
      if (mapped.length === 0) {
        this.addChild(new Text(currentTheme.fg("warning", "Nothing found."), 1, 0));
      } else {
        this.selectList = new SelectList(mapped, Math.min(mapped.length, 12), {
          selectedPrefix: (text) => currentTheme.fg("accent", text),
          selectedText: (text) => currentTheme.fg("accent", text),
          description: (text) => currentTheme.fg("muted", text),
          scrollInfo: (text) => currentTheme.fg("dim", text),
          noMatch: (text) => currentTheme.fg("warning", text),
        }, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 42 });
        this.selectList.onSelect = (selected) => {
          const original = items.find((item) => toItem(item).value === selected.value);
          if (original === undefined) return;
          void onSelect(original).catch((error: unknown) => {
            menu.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }).finally(menu.done);
        };
        this.selectList.onCancel = menu.done;
        this.addChild(this.selectList);
      }
      this.addChild(new Spacer(1));
      this.addChild(new Text(currentTheme.fg("dim", "  Enter to select · Esc to go back"), 1, 0));
      this.addChild(border());
      menu.tui.requestRender();
    }).catch((error: unknown) => {
      this.clear();
      this.addChild(new Text(currentTheme.fg("error", error instanceof Error ? error.message : String(error)), 1, 0));
      this.addChild(new Text(currentTheme.fg("dim", "Press Esc to go back"), 1, 0));
      menu.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    this.selectList?.handleInput(data);
  }
}

class TextPanel extends Container {
  constructor(title: string, body: string, onCancel: () => void) {
    super();
    this.addChild(border());
    this.addChild(new Text(currentTheme.fg("accent", currentTheme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(body, 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(currentTheme.fg("dim", "Press Esc to go back"), 1, 0));
    this.addChild(border());
    this.onCancel = onCancel;
  }

  private readonly onCancel: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.onCancel();
  }
}

class NumberInputPanel extends Container {
  private readonly input = new Input();

  constructor(title: string, description: string, submit: (value: string) => Promise<void>, onError: (error: unknown) => void, done: () => void) {
    super();
    this.addChild(border());
    this.addChild(new Text(currentTheme.fg("accent", currentTheme.bold(title)), 1, 0));
    this.addChild(new Text(currentTheme.fg("muted", description), 1, 0));
    this.addChild(new Spacer(1));
    this.input.onSubmit = (value) => void submit(value).catch(onError).finally(done);
    this.input.onEscape = done;
    this.addChild(this.input);
    this.addChild(new Spacer(1));
    this.addChild(new Text(currentTheme.fg("dim", "Enter to continue · Esc to go back"), 1, 0));
    this.addChild(border());
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

function showText(menu: MenuContext, title: string, body: string): Promise<void> {
  return menu.ctx.ui.custom<void>((_tui, _theme, _kb, done) => new TextPanel(title, body, done), { overlay: true }).then(() => undefined);
}

function prPicker(menu: MenuContext, title: string, description: string, operation: (number: number) => Promise<void>): Component {
  return new SelectPanel(title, description, menu, menu.actions.listPullRequests, (pr) => ({
    value: String(pr.number),
    label: `#${pr.number} ${pr.title}`,
    description: `${pr.author} · ${pr.checks} checks · ${pr.reviewDecision}${pr.isDraft ? " · draft" : ""}`,
  }), (pr) => operation(pr.number));
}

function issuePicker(menu: MenuContext): Component {
  return new SelectPanel("Issues", "Select an open issue", menu, () => menu.actions.listIssues(), (issue) => ({
    value: String(issue.number),
    label: `#${issue.number} ${issue.title}`,
    description: `${issue.author}${issue.labels ? ` · ${issue.labels}` : ""}`,
  }), async (issue) => showText(menu, `Issue #${issue.number}`, await menu.actions.showIssue(issue.number)));
}

function safe(menu: MenuContext, operation: () => Promise<void>): void {
  void operation().catch((error: unknown) => menu.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
}

function makeWorkflow(menu: MenuContext): Component {
  return new SettingsPanel("GitHub · PR workflow", "Checkout and restore pull-request code safely.", [
    { id: "checkout", label: "Checkout a PR", description: "Choose an open PR and checkout its code.", currentValue: "choose PR", submenu: () => prPicker(menu, "Checkout PR", "Select an open pull request", menu.actions.checkoutPullRequest) },
    { id: "checkout-number", label: "Checkout by number", description: "Enter a pull-request number directly.", currentValue: "enter number", submenu: () => new NumberInputPanel("Checkout PR", "Enter a pull-request number", async (value) => {
      const number = Number.parseInt(value.trim(), 10);
      if (!Number.isInteger(number) || number < 1) throw new Error("Enter a valid pull-request number.");
      await menu.actions.checkoutByNumber(number);
    }, (error) => menu.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"), menu.done) },
    { id: "return", label: "Return from PR", description: "Restore the branch saved before checkout.", currentValue: "restore", values: ["restore"] },
    { id: "refresh", label: "Refresh PR list", description: "Reload GitHub data on the next picker.", currentValue: "refresh", values: ["refresh"] },
  ], (id) => {
    if (id === "return") safe(menu, menu.actions.returnFromPullRequest);
    if (id === "refresh") safe(menu, menu.actions.refreshPullRequests);
  }, menu.done);
}

function makeBrowse(menu: MenuContext): Component {
  return new SettingsPanel("GitHub · Browse", "Inspect pull requests, diffs, issues, and repository links.", [
    { id: "details", label: "PR details", description: "View description, branches, reviews, labels, and mergeability.", currentValue: "choose PR", submenu: () => prPicker(menu, "PR details", "Select a pull request", async (number) => showText(menu, `PR #${number}`, await menu.actions.showPullRequest(number))) },
    { id: "diff", label: "PR diff", description: "View the selected pull request's diff.", currentValue: "choose PR", submenu: () => prPicker(menu, "PR diff", "Select a pull request", async (number) => showText(menu, `PR #${number} diff`, await menu.actions.showDiff(number))) },
    { id: "list", label: "List open PRs", description: "Display the currently open pull requests.", currentValue: "list", values: ["list"] },
    { id: "open-pr", label: "Open PR in browser", description: "Choose a PR and open it in the browser.", currentValue: "choose PR", submenu: () => prPicker(menu, "Open PR", "Select a pull request", menu.actions.openPullRequest) },
    { id: "issues", label: "Issues", description: "Browse open issues.", currentValue: "choose issue", submenu: () => issuePicker(menu) },
    { id: "open-repo", label: "Open repository", description: "Open the current GitHub repository in the browser.", currentValue: "open", values: ["open"] },
  ], (id) => {
    if (id === "list") safe(menu, async () => {
      const prs = await menu.actions.listPullRequests();
      await showText(menu, "Open pull requests", prs.length ? prs.map((pr) => `#${pr.number} ${pr.title} · ${pr.author} · ${pr.checks}`).join("\n") : "No open pull requests.");
    });
    if (id === "open-repo") safe(menu, menu.actions.openRepository);
  }, menu.done);
}

function makeChecks(menu: MenuContext): Component {
  return new SettingsPanel("GitHub · Checks and CI", "Review and wait for pull-request checks.", [
    { id: "current", label: "Current checks", description: "Show checks for the current branch's pull request.", currentValue: "view", values: ["view"] },
    { id: "pr", label: "PR checks", description: "Choose a PR and show its checks.", currentValue: "choose PR", submenu: () => prPicker(menu, "PR checks", "Select a pull request", async (number) => showText(menu, `PR #${number} checks`, await menu.actions.showChecks(number))) },
    { id: "wait", label: "Wait for checks", description: "Poll checks until they finish. Escape cancels the wait.", currentValue: "choose PR", submenu: () => prPicker(menu, "Wait for checks", "Select a pull request", async (number) => showText(menu, `PR #${number} checks`, await menu.actions.waitForChecks(number))) },
  ], (id) => {
    if (id === "current") safe(menu, async () => showText(menu, "Current checks", await menu.actions.showChecks()));
  }, menu.done);
}

function makeRepository(menu: MenuContext): Component {
  const chooseAnd = (title: string, operation: (number: number) => Promise<void>): Component => prPicker(menu, title, "Select a pull request", operation);
  return new SettingsPanel("GitHub · Repository actions", "Actions that can modify Git or GitHub always ask for confirmation.", [
    { id: "create", label: "Create PR", description: "Create a pull request from the current branch.", currentValue: "start", values: ["start"] },
    { id: "push", label: "Push current branch", description: "Push the current branch after confirmation.", currentValue: "push", values: ["push"] },
    { id: "edit", label: "Edit PR", description: "Choose a PR and edit its title/body.", currentValue: "choose PR", submenu: () => chooseAnd("Edit PR", menu.actions.editPullRequest) },
    { id: "comment", label: "Comment on PR", description: "Choose a PR and add a comment.", currentValue: "choose PR", submenu: () => chooseAnd("Comment on PR", menu.actions.commentOnPullRequest) },
    { id: "ready", label: "Mark ready for review", description: "Choose a draft PR to mark ready.", currentValue: "choose PR", submenu: () => chooseAnd("Mark ready", menu.actions.markPullRequestReady) },
    { id: "state", label: "Close or reopen PR", description: "Choose a PR and change its state.", currentValue: "choose PR", submenu: () => chooseAnd("Change PR state", async (number) => {
      const state = await menu.ctx.ui.select("PR state", ["Close", "Reopen"]);
      if (state) await menu.actions.setPullRequestState(number, state === "Close" ? "close" : "reopen");
    }) },
    { id: "merge", label: "Merge PR", description: "Choose a PR and explicitly confirm the merge method.", currentValue: "choose PR", submenu: () => chooseAnd("Merge PR", menu.actions.mergePullRequest) },
  ], (id) => {
    if (id === "create") safe(menu, menu.actions.createPullRequest);
    if (id === "push") safe(menu, menu.actions.pushCurrentBranch);
  }, menu.done);
}

function makeLocal(menu: MenuContext): Component {
  const items: SettingItem[] = [
    { id: "dirty-policy", label: "Dirty tree policy", description: "Refuse is safest; assisted commit offers an explicit commit flow.", currentValue: menu.settings.dirtyPolicy, values: ["refuse", "offer-commit"] },
    { id: "clean-commit", label: "Require clean commit", description: "Always verify HEAD is a real commit before PR checkout.", currentValue: "yes", values: ["yes"] },
    { id: "unpushed", label: "Warn about unpushed commits", description: "Warn when the current branch is ahead of its upstream.", currentValue: menu.settings.warnUnpushed ? "yes" : "no", values: ["yes", "no"] },
    { id: "confirm", label: "Confirm branch changes", description: "Ask before checkout, branch, push, commit, or merge operations.", currentValue: menu.settings.confirmBranchChanges ? "yes" : "no", values: ["yes", "no"] },
    { id: "refresh-data", label: "Auto-refresh GitHub data", description: "Refresh issue autocomplete after each session starts.", currentValue: menu.settings.autoRefresh ? "yes" : "no", values: ["yes", "no"] },
  ];
  return new SettingsPanel("GitHub · Local workflow", "Configure safe checkout behavior.", items, (id, value) => {
    if (id === "dirty-policy") menu.settings.dirtyPolicy = value as PluginSettings["dirtyPolicy"];
    if (id === "unpushed") menu.settings.warnUnpushed = value === "yes";
    if (id === "confirm") menu.settings.confirmBranchChanges = value === "yes";
    if (id === "refresh-data") menu.settings.autoRefresh = value === "yes";
    menu.actions.saveSettings(menu.settings);
  }, menu.done);
}

function makeStatus(menu: MenuContext): Component {
  return new SettingsPanel("GitHub · Status", "Show current repository and authentication state.", [
    { id: "status", label: "Repository status", description: "Show Git, GitHub, authentication, PR, and check status.", currentValue: "view", values: ["view"] },
  ], (id) => {
    if (id === "status") safe(menu, async () => showText(menu, "GitHub status", await menu.actions.showStatus()));
  }, menu.done);
}

export function createGithubMenu(
  ctx: ExtensionContext,
  settings: PluginSettings,
  actions: GithubMenuActions,
  tui: { requestRender(): void },
  done: () => void,
): Component {
  currentTheme = ctx.ui.theme;
  const menu: MenuContext = { ctx, settings, actions, tui, done };
  const root = new SettingsPanel("GitHub", "Use Enter to open a section; Esc to go back.", [
    { id: "workflow", label: "PR workflow", description: "Checkout and restore pull-request code.", currentValue: "open", submenu: (_value, back) => makeWorkflow({ ...menu, done: back }) },
    { id: "browse", label: "Browse GitHub", description: "Inspect PRs, diffs, issues, and repository links.", currentValue: "open", submenu: (_value, back) => makeBrowse({ ...menu, done: back }) },
    { id: "checks", label: "Checks and CI", description: "Review or wait for GitHub checks.", currentValue: "open", submenu: (_value, back) => makeChecks({ ...menu, done: back }) },
    { id: "repository", label: "Repository actions", description: "Create PRs and perform confirmation-gated actions.", currentValue: "open", submenu: (_value, back) => makeRepository({ ...menu, done: back }) },
    { id: "local", label: "Local workflow", description: "Configure checkout and safety preferences.", currentValue: "configure", submenu: (_value, back) => makeLocal({ ...menu, done: back }) },
    { id: "status", label: "GitHub status", description: "Show current repository and authentication state.", currentValue: "view", submenu: (_value, back) => makeStatus({ ...menu, done: back }) },
  ], () => done(), done);
  return root;
}
