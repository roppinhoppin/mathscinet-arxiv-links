const SOURCE_MODE_KEY = "arxivSourceMode";
const SOURCE_MODES = {
  AUTO: "auto",
  OPENALEX: "openalex",
  ARXIV: "arxiv"
};
const MODE_MENU_PREFIX = "source-mode-";

function normalizeSourceMode(mode) {
  if (mode === SOURCE_MODES.OPENALEX) return SOURCE_MODES.OPENALEX;
  if (mode === SOURCE_MODES.ARXIV) return SOURCE_MODES.ARXIV;
  return SOURCE_MODES.AUTO;
}

function modeBadge(mode) {
  if (mode === SOURCE_MODES.OPENALEX) return "OA";
  if (mode === SOURCE_MODES.ARXIV) return "AX";
  return "AU";
}

function modeBadgeColor(mode) {
  if (mode === SOURCE_MODES.OPENALEX) return "#1b5e20";
  if (mode === SOURCE_MODES.ARXIV) return "#bf360c";
  return "#0d47a1";
}

function getStoredMode() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ [SOURCE_MODE_KEY]: SOURCE_MODES.AUTO }, (data) => {
      resolve(normalizeSourceMode(data[SOURCE_MODE_KEY]));
    });
  });
}

function setStoredMode(mode) {
  const normalized = normalizeSourceMode(mode);
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [SOURCE_MODE_KEY]: normalized }, () => resolve(normalized));
  });
}

function updateBadge(mode) {
  const normalized = normalizeSourceMode(mode);
  chrome.action.setBadgeText({ text: modeBadge(normalized) });
  chrome.action.setBadgeBackgroundColor({ color: modeBadgeColor(normalized) });
}

function createContextMenus(mode) {
  const normalized = normalizeSourceMode(mode);
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "source-root",
      title: "ArXiv Source Mode",
      contexts: ["action"]
    });
    chrome.contextMenus.create({
      id: `${MODE_MENU_PREFIX}${SOURCE_MODES.AUTO}`,
      parentId: "source-root",
      title: "Auto (OpenAlex -> arXiv)",
      type: "radio",
      checked: normalized === SOURCE_MODES.AUTO,
      contexts: ["action"]
    });
    chrome.contextMenus.create({
      id: `${MODE_MENU_PREFIX}${SOURCE_MODES.OPENALEX}`,
      parentId: "source-root",
      title: "OpenAlex only",
      type: "radio",
      checked: normalized === SOURCE_MODES.OPENALEX,
      contexts: ["action"]
    });
    chrome.contextMenus.create({
      id: `${MODE_MENU_PREFIX}${SOURCE_MODES.ARXIV}`,
      parentId: "source-root",
      title: "arXiv API only",
      type: "radio",
      checked: normalized === SOURCE_MODES.ARXIV,
      contexts: ["action"]
    });
  });
}

async function initializeSourceModeUi() {
  const mode = await getStoredMode();
  updateBadge(mode);
  createContextMenus(mode);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "FETCH_ARXIV" || request.type === "FETCH_MREF" || request.type === "FETCH_OPENALEX") {
    fetch(request.url)
      .then(response => response.text())
      .then(text => sendResponse({ data: text }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await setStoredMode(await getStoredMode());
  await initializeSourceModeUi();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSourceModeUi();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId || !String(info.menuItemId).startsWith(MODE_MENU_PREFIX)) return;
  const mode = String(info.menuItemId).slice(MODE_MENU_PREFIX.length);
  const storedMode = await setStoredMode(mode);
  updateBadge(storedMode);
  createContextMenus(storedMode);

  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "SOURCE_MODE_UPDATED", mode: storedMode });
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_SEARCH" });
  }
});

void initializeSourceModeUi();
