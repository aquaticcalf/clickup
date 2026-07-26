import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, SettingsList, Spacer, Text, matchesKey, type Component, type SelectItem, type SettingItem } from "@earendil-works/pi-tui";
import type { IssueSummary, PullRequestSummary } from "./github.ts";
import type { PluginSettings } from "./index.ts";

export interface GithubMenuActions {
  listPullRequests(): Promise<PullRequestSummary[]>;
  checkoutPullRequest(number: number): Promise<string | undefined>;
  checkoutByNumber(number: number): Promise<string | undefined>;
  returnFromPullRequest(): Promise<string | undefined>;
  refreshPullRequests(): Promise<string | undefined>;
  showStatus(): Promise<string>;
  showPullRequest(number: number): Promise<string>;
  showDiff(number: number): Promise<string>;
  openPullRequest(number: number): Promise<string | undefined>;
  openRepository(): Promise<string | undefined>;
  showChecks(number?: number): Promise<string>;
  waitForChecks(number: number): Promise<string>;
  listIssues(query?: string): Promise<IssueSummary[]>;
  showIssue(number: number): Promise<string>;
  openIssue(number: number): Promise<string | undefined>;
  createPullRequest(): Promise<string | undefined>;
  pushCurrentBranch(): Promise<string | undefined>;
  editPullRequest(number: number): Promise<string | undefined>;
  commentOnPullRequest(number: number): Promise<string | undefined>;
  setPullRequestState(number: number, state: "close" | "reopen"): Promise<string | undefined>;
  markPullRequestReady(number: number): Promise<string | undefined>;
  mergePullRequest(number: number, method: "merge" | "squash" | "rebase"): Promise<string | undefined>;
  saveSettings(settings: PluginSettings): void;
}

interface MenuContext {
  ctx: ExtensionContext;
  settings: PluginSettings;
  actions: GithubMenuActions;
  tui: { requestRender(): void };
  done: () => void;
}

type PanelResult = string | Component | undefined;

let currentTheme: ExtensionContext["ui"]["theme"];

function border(): DynamicBorder {
  return new DynamicBorder((text: string) => currentTheme.fg("accent", text));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A core-style settings page: one list, one title, and one consistent escape path. */
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
    this.addChild(new Text(currentTheme.bold(currentTheme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(currentTheme.fg("muted", description), 0, 0));
    }
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
    this.addChild(new Spacer(1));
    this.addChild(new Text(currentTheme.fg("dim", "  Enter to open · Esc to go back"), 0, 0));
    this.addChild(border());
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

/** Inline result screen. Results no longer jump into a notification overlay. */
class MessagePanel extends Container {
  constructor(title: string, body: string, onCancel: () => void, tone: "normal" | "error" = "normal") {
    super();
    this.addChild(border());
    this.addChild(new Text(currentTheme.bold(currentTheme.fg("accent", title)), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(tone === "error" ? currentTheme.fg("error", body) : body, 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(currentTheme.fg("dim", "  Esc to go back"), 0, 0));
    this.addChild(border());
    this.onCancel = onCancel;
  }

  private readonly onCancel: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.onCancel();
  }
}

/** A loading/action page that stays in the same menu instead of using notify(). */
class ActionPanel extends Container {
  private active: Component;

  constructor(
    title: string,
    description: string,
    operation: () => Promise<string | undefined>,
    onCancel: () => void,
    requestRender: () => void,
  ) {
    super();
    this.active = new MessagePanel(title, `${description}\n\nWorking…`, onCancel);
    this.renderFrame();
    void operation().then((result) => {
      this.active = new MessagePanel(title, `${description}\n\n${result ?? "No changes made."}`, onCancel);
      this.renderFrame();
      requestRender();
    }).catch((error: unknown) => {
      this.active = new MessagePanel(title, `${description}\n\n${errorText(error)}`, onCancel, "error");
      this.renderFrame();
      requestRender();
    });
  }

  private renderFrame(): void {
    this.clear();
    this.addChild(this.active);
  }

  handleInput(data: string): void {
    this.active.handleInput?.(data);
  }
}

/** Async selector used by the GitHub API. Loading, errors, and results share one page. */
class SelectPanel<T> extends Container {
  private active: Component;
  private list: SelectList | undefined;
  private readonly title: string;
  private readonly description: string;
  private readonly menu: MenuContext;
  private readonly load: () => Promise<T[]>;
  private readonly toItem: (item: T) => SelectItem;
  private readonly onSelect: (item: T) => Promise<PanelResult>;

  constructor(
    title: string,
    description: string,
    menu: MenuContext,
    load: () => Promise<T[]>,
    toItem: (item: T) => SelectItem,
    onSelect: (item: T) => Promise<PanelResult>,
  ) {
    super();
    this.title = title;
    this.description = description;
    this.menu = menu;
    this.load = load;
    this.toItem = toItem;
    this.onSelect = onSelect;
    this.active = new MessagePanel(title, "Loading…", menu.done);
    this.renderFrame();
    void this.reload();
  }

  async showList(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.list = undefined;
    this.active = new MessagePanel(this.title, "Loading…", this.menu.done);
    this.renderFrame();
    this.menu.tui.requestRender();
    try {
      const items = await this.load();
      if (items.length === 0) {
        this.active = new MessagePanel(this.title, "Nothing found.", this.menu.done);
      } else {
        this.list = new SelectList(
          items.map(this.toItem),
          Math.min(items.length, 12),
          {
            selectedPrefix: (text) => currentTheme.fg("accent", text),
            selectedText: (text) => currentTheme.fg("accent", text),
            description: (text) => currentTheme.fg("muted", text),
            scrollInfo: (text) => currentTheme.fg("dim", text),
            noMatch: (text) => currentTheme.fg("warning", text),
          },
          { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 42 },
        );
        this.list.onSelect = (selected) => {
          const index = items.findIndex((item) => this.toItem(item).value === selected.value);
          const original = index >= 0 ? items[index] : undefined;
          if (original === undefined) return;
          void this.onSelect(original).then((result) => {
            if (result && typeof result !== "string") {
              this.active = result;
            } else {
              this.active = new MessagePanel(this.title, result ?? "No changes made.", this.menu.done);
            }
            this.list = undefined;
            this.renderFrame();
            this.menu.tui.requestRender();
          }).catch((error: unknown) => {
            this.list = undefined;
            this.active = new MessagePanel(this.title, errorText(error), this.menu.done, "error");
            this.renderFrame();
            this.menu.tui.requestRender();
          });
        };
        this.list.onCancel = this.menu.done;
        this.active = this.list;
      }
      this.renderFrame();
      this.menu.tui.requestRender();
    } catch (error: unknown) {
      this.active = new MessagePanel(this.title, errorText(error), this.menu.done, "error");
      this.renderFrame();
      this.menu.tui.requestRender();
    }
  }

  private renderFrame(): void {
    this.clear();
    if (!this.list) {
      this.addChild(this.active);
      return;
    }
    this.addChild(border());
    this.addChild(new Text(currentTheme.bold(currentTheme.fg("accent", this.title)), 0, 0));
    if (this.description) this.addChild(new Text(currentTheme.fg("muted", this.description), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.active);
    this.addChild(new Spacer(1));
    this.addChild(new Text(currentTheme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
    this.addChild(border());
  }

  handleInput(data: string): void {
    this.active.handleInput?.(data);
  }
}

class NumberInputPanel extends Container {
  private readonly input = new Input();
  private active: Component;
  private readonly onCancel: () => void;
  private readonly requestRender: () => void;
  private readonly title: string;

  constructor(
    title: string,
    description: string,
    submit: (value: string) => Promise<string | undefined>,
    onCancel: () => void,
    requestRender: () => void,
  ) {
    super();
    this.title = title;
    this.onCancel = onCancel;
    this.requestRender = requestRender;
    this.active = this.input;
    this.input.onSubmit = (value) => {
      void submit(value).then((result) => this.showResult(result ?? "No changes made.")).catch((error: unknown) => this.showResult(errorText(error), true));
    };
    this.input.onEscape = onCancel;
    this.renderFrame(description);
  }

  private showResult(body: string, error = false): void {
    this.active = new MessagePanel(this.title, body, this.onCancel, error ? "error" : "normal");
    this.renderFrame("");
    this.requestRender();
  }

  private renderFrame(description: string): void {
    this.clear();
    if (this.active !== this.input) {
      this.addChild(this.active);
      return;
    }
    this.addChild(border());
    this.addChild(new Text(currentTheme.bold(currentTheme.fg("accent", this.title)), 0, 0));
    if (description) this.addChild(new Text(currentTheme.fg("muted", description), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.active);
    this.addChild(new Text(currentTheme.fg("dim", "  Enter to continue · Esc to go back"), 0, 0));
    this.addChild(border());
  }

  handleInput(data: string): void {
    this.active.handleInput?.(data);
  }
}

function actionPanel(menu: MenuContext, title: string, description: string, operation: () => Promise<string | undefined>): Component {
  return new ActionPanel(title, description, operation, menu.done, menu.tui.requestRender);
}

function readPanel(menu: MenuContext, title: string, description: string, load: () => Promise<string>): Component {
  return actionPanel(menu, title, description, load);
}

function pullRequestItem(pr: PullRequestSummary): SelectItem {
  return {
    value: String(pr.number),
    label: `#${pr.number} ${pr.title}`,
    description: `${pr.author} · ${pr.checks} checks · ${pr.reviewDecision}${pr.isDraft ? " · draft" : ""}`,
  };
}

function prPicker(
  menu: MenuContext,
  title: string,
  description: string,
  operation: (number: number, back: () => void) => Promise<PanelResult>,
): Component {
  let picker: SelectPanel<PullRequestSummary>;
  picker = new SelectPanel(
    title,
    description,
    menu,
    menu.actions.listPullRequests,
    pullRequestItem,
    (pr) => operation(pr.number, () => { void picker.showList(); }),
  );
  return picker;
}

function issuePicker(menu: MenuContext): Component {
  return new SelectPanel(
    "Issues",
    "Select an open issue",
    menu,
    () => menu.actions.listIssues(),
    (issue) => ({
      value: String(issue.number),
      label: `#${issue.number} ${issue.title}`,
      description: `${issue.author}${issue.labels ? ` · ${issue.labels}` : ""}`,
    }),
    (issue) => menu.actions.showIssue(issue.number),
  );
}

function choicePanel(
  menu: MenuContext,
  title: string,
  description: string,
  choices: SelectItem[],
  onSelect: (value: string) => Promise<string | undefined>,
  onCancel: () => void,
): Component {
  const panelMenu = { ...menu, done: onCancel };
  return new SelectPanel(
    title,
    description,
    panelMenu,
    async () => choices,
    (choice) => choice,
    (choice) => onSelect(choice.value),
  );
}

function makeWorkflow(menu: MenuContext): Component {
  return new SettingsPanel("PR workflow", "Checkout and restore pull-request code safely.", [
    {
      id: "checkout",
      label: "Checkout a PR",
      description: "Choose an open PR and checkout its code.",
      currentValue: "choose PR",
      submenu: () => prPicker(menu, "Checkout PR", "Select an open pull request", (number) => menu.actions.checkoutPullRequest(number)),
    },
    {
      id: "checkout-number",
      label: "Checkout by number",
      description: "Enter a pull-request number directly.",
      currentValue: "enter number",
      submenu: () => new NumberInputPanel("Checkout PR", "Enter a pull-request number", async (value) => {
        const number = Number.parseInt(value.trim(), 10);
        if (!Number.isInteger(number) || number < 1) throw new Error("Enter a valid pull-request number.");
        return menu.actions.checkoutByNumber(number);
      }, menu.done, menu.tui.requestRender),
    },
    {
      id: "return",
      label: "Return from PR",
      description: "Restore the branch saved before checkout.",
      currentValue: "restore",
      submenu: () => actionPanel(menu, "Return from PR", "Restore the original branch.", menu.actions.returnFromPullRequest),
    },
    {
      id: "refresh",
      label: "Refresh PR list",
      description: "Refresh GitHub data before choosing a pull request.",
      currentValue: "refresh",
      submenu: () => actionPanel(menu, "Refresh PR list", "Reload open pull requests.", menu.actions.refreshPullRequests),
    },
  ], () => undefined, menu.done);
}

function makeBrowse(menu: MenuContext): Component {
  return new SettingsPanel("Browse GitHub", "Inspect pull requests, diffs, issues, and repository links.", [
    {
      id: "details",
      label: "PR details",
      description: "View description, branches, reviews, labels, and mergeability.",
      currentValue: "choose PR",
      submenu: () => prPicker(menu, "PR details", "Select a pull request", (number) => menu.actions.showPullRequest(number)),
    },
    {
      id: "diff",
      label: "PR diff",
      description: "View a pull request's diff.",
      currentValue: "choose PR",
      submenu: () => prPicker(menu, "PR diff", "Select a pull request", (number) => menu.actions.showDiff(number)),
    },
    {
      id: "list",
      label: "List open PRs",
      description: "Display the currently open pull requests.",
      currentValue: "view",
      submenu: () => readPanel(menu, "Open pull requests", "Currently open pull requests.", async () => {
        const prs = await menu.actions.listPullRequests();
        return prs.length ? prs.map((pr) => `#${pr.number} ${pr.title} · ${pr.author} · ${pr.checks}`).join("\n") : "No open pull requests.";
      }),
    },
    {
      id: "open-pr",
      label: "Open PR in browser",
      description: "Choose a PR and open it in the browser.",
      currentValue: "choose PR",
      submenu: () => prPicker(menu, "Open PR", "Select a pull request", (number) => menu.actions.openPullRequest(number)),
    },
    { id: "issues", label: "Issues", description: "Browse open issues.", currentValue: "choose issue", submenu: () => issuePicker(menu) },
    {
      id: "open-repo",
      label: "Open repository",
      description: "Open the current GitHub repository in the browser.",
      currentValue: "open",
      submenu: () => actionPanel(menu, "Open repository", "Open the repository in your browser.", menu.actions.openRepository),
    },
  ], () => undefined, menu.done);
}

function makeChecks(menu: MenuContext): Component {
  return new SettingsPanel("Checks and CI", "Review and wait for pull-request checks.", [
    {
      id: "current",
      label: "Current checks",
      description: "Show checks for the current branch's pull request.",
      currentValue: "view",
      submenu: () => readPanel(menu, "Current checks", "Checks for the current pull request.", () => menu.actions.showChecks()),
    },
    {
      id: "pr",
      label: "PR checks",
      description: "Choose a PR and show its checks.",
      currentValue: "choose PR",
      submenu: () => prPicker(menu, "PR checks", "Select a pull request", (number) => menu.actions.showChecks(number)),
    },
    {
      id: "wait",
      label: "Wait for checks",
      description: "Poll checks until they finish. Escape cancels the wait.",
      currentValue: "choose PR",
      submenu: () => prPicker(menu, "Wait for checks", "Select a pull request", (number) => menu.actions.waitForChecks(number)),
    },
  ], () => undefined, menu.done);
}

function makeRepository(menu: MenuContext): Component {
  const chooseAnd = (title: string, operation: (number: number, back: () => void) => Promise<PanelResult>): Component =>
    prPicker(menu, title, "Select a pull request", operation);

  return new SettingsPanel("Repository actions", "Changes stay in this menu; confirmations still protect destructive actions.", [
    { id: "create", label: "Create PR", description: "Create a pull request from the current branch.", currentValue: "start", submenu: () => actionPanel(menu, "Create PR", "Create a pull request from the current branch.", menu.actions.createPullRequest) },
    { id: "push", label: "Push current branch", description: "Push the current branch after confirmation.", currentValue: "push", submenu: () => actionPanel(menu, "Push current branch", "Push local commits to the configured upstream.", menu.actions.pushCurrentBranch) },
    { id: "edit", label: "Edit PR", description: "Choose a PR and edit its title/body.", currentValue: "choose PR", submenu: () => chooseAnd("Edit PR", (number) => menu.actions.editPullRequest(number)) },
    { id: "comment", label: "Comment on PR", description: "Choose a PR and add a comment.", currentValue: "choose PR", submenu: () => chooseAnd("Comment on PR", (number) => menu.actions.commentOnPullRequest(number)) },
    { id: "ready", label: "Mark ready for review", description: "Choose a draft PR to mark ready.", currentValue: "choose PR", submenu: () => chooseAnd("Mark ready", (number) => menu.actions.markPullRequestReady(number)) },
    {
      id: "state",
      label: "Close or reopen PR",
      description: "Choose a PR and change its state.",
      currentValue: "choose PR",
      submenu: () => chooseAnd("Change PR state", async (number, back) => choicePanel(
        menu,
        "PR state",
        "Choose what to do with this pull request.",
        [{ value: "close", label: "Close" }, { value: "reopen", label: "Reopen" }],
        (state) => menu.actions.setPullRequestState(number, state as "close" | "reopen"),
        back,
      )),
    },
    {
      id: "merge",
      label: "Merge PR",
      description: "Choose a PR and explicitly confirm the merge method.",
      currentValue: "choose PR",
      submenu: () => chooseAnd("Merge PR", async (number, back) => choicePanel(
        menu,
        "Merge method",
        "Choose a merge method for this pull request.",
        [{ value: "merge", label: "Merge" }, { value: "squash", label: "Squash" }, { value: "rebase", label: "Rebase" }],
        (method) => menu.actions.mergePullRequest(number, method as "merge" | "squash" | "rebase"),
        back,
      )),
    },
  ], () => undefined, menu.done);
}

function makeLocal(menu: MenuContext): Component {
  const items: SettingItem[] = [
    { id: "dirty-policy", label: "Dirty tree policy", description: "Refuse is safest; assisted commit offers an explicit commit flow.", currentValue: menu.settings.dirtyPolicy, values: ["refuse", "offer-commit"] },
    { id: "unpushed", label: "Warn about unpushed commits", description: "Warn when the current branch is ahead of its upstream.", currentValue: menu.settings.warnUnpushed ? "yes" : "no", values: ["yes", "no"] },
    { id: "confirm", label: "Confirm branch changes", description: "Ask before checkout, branch, push, commit, or merge operations.", currentValue: menu.settings.confirmBranchChanges ? "yes" : "no", values: ["yes", "no"] },
    { id: "refresh-data", label: "Auto-refresh GitHub data", description: "Refresh issue autocomplete after each session starts.", currentValue: menu.settings.autoRefresh ? "yes" : "no", values: ["yes", "no"] },
  ];
  return new SettingsPanel("Local workflow", "Configure checkout and safety preferences.", items, (id, value) => {
    if (id === "dirty-policy") menu.settings.dirtyPolicy = value as PluginSettings["dirtyPolicy"];
    if (id === "unpushed") menu.settings.warnUnpushed = value === "yes";
    if (id === "confirm") menu.settings.confirmBranchChanges = value === "yes";
    if (id === "refresh-data") menu.settings.autoRefresh = value === "yes";
    menu.actions.saveSettings(menu.settings);
  }, menu.done);
}

function makeStatus(menu: MenuContext): Component {
  return new SettingsPanel("GitHub status", "Show current repository and authentication state.", [
    { id: "status", label: "Repository status", description: "Show Git, GitHub, authentication, PR, and check status.", currentValue: "view", submenu: () => readPanel(menu, "GitHub status", "Current repository and authentication state.", menu.actions.showStatus) },
  ], () => undefined, menu.done);
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
  return new SettingsPanel("GitHub", "Choose a section. Enter opens it; Esc goes back.", [
    { id: "workflow", label: "PR workflow", description: "Checkout and restore pull-request code.", currentValue: "open", submenu: (_value, back) => makeWorkflow({ ...menu, done: back }) },
    { id: "browse", label: "Browse GitHub", description: "Inspect PRs, diffs, issues, and repository links.", currentValue: "open", submenu: (_value, back) => makeBrowse({ ...menu, done: back }) },
    { id: "checks", label: "Checks and CI", description: "Review or wait for GitHub checks.", currentValue: "open", submenu: (_value, back) => makeChecks({ ...menu, done: back }) },
    { id: "repository", label: "Repository actions", description: "Create PRs and perform confirmation-gated actions.", currentValue: "open", submenu: (_value, back) => makeRepository({ ...menu, done: back }) },
    { id: "local", label: "Local workflow", description: "Configure checkout and safety preferences.", currentValue: "configure", submenu: (_value, back) => makeLocal({ ...menu, done: back }) },
    { id: "status", label: "GitHub status", description: "Show current repository and authentication state.", currentValue: "view", submenu: (_value, back) => makeStatus({ ...menu, done: back }) },
  ], () => undefined, done);
}
