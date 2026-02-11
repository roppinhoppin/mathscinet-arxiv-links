chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "FETCH_ARXIV") {
    fetch(request.url)
      .then(response => response.text())
      .then(text => sendResponse({ data: text }))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }
  
  if (request.type === "FETCH_MREF" || request.type === "FETCH_OPENALEX") {
    fetch(request.url)
      .then(response => response.text())
      .then(text => sendResponse({ data: text }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_SEARCH" });
});
