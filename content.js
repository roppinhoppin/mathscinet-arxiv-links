const DEBUG = true;
const VERSION = "1.12-PARALLEL-LEFT";
function log(...args) {
  if (DEBUG) console.log(`MathSciNet ArXiv Links [${VERSION}]:`, ...args);
}

function areTitlesSimilar(t1, t2) {
  if (!t1 || !t2) return false;
  const norm = (s) => s.toLowerCase().replace(/--/g, '-').replace(/[^a-z0-9]/g, '').trim();
  const n1 = norm(t1);
  const n2 = norm(t2);
  return n1.includes(n2) || n2.includes(n1);
}

// Utility to catch background script responses
async function callBackground(url, type = "FETCH_ARXIV") {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, url }, (response) => {
      if (chrome.runtime.lastError) {
        log("Background Error (Runtime):", chrome.runtime.lastError);
        reject(chrome.runtime.lastError);
      } else if (response && response.error) {
        log("Background Error (Response):", response.error);
        reject(new Error(response.error));
      } else {
        resolve(response ? response.data : null);
      }
    });
  });
}

function cleanAuthorName(name) {
  if (!name) return "";
  let clean = name.replace(/\(.*\)/g, '').trim();
  if (clean.includes(',')) {
    const parts = clean.split(',').map(s => s.trim());
    clean = parts[1] + " " + parts[0];
  }
  return clean;
}

// Extract metadata from a refined structure for search results
function getSearchItemMetadata(headerDiv) {
  const links = Array.from(headerDiv.querySelectorAll('a[href*="/mathscinet/article?mr="]'));
  if (links.length < 1) return null;

  const mrLink = links[0];
  const localMRNumber = mrLink.textContent.includes('MR') ? mrLink.textContent.match(/MR\d+/)[0] : "MR" + mrLink.textContent.trim();
  
  // Title is generally the second MR-related link
  const titleLink = links.length > 1 ? links[1] : null;
  const title = titleLink ? titleLink.textContent.trim() : "";

  // Authors are in the next sibling div.ml-2
  let authors = [];
  let current = headerDiv.nextElementSibling;
  
  // Skip potential corrected title div or empty text nodes
  while (current && !current.querySelector('a[href*="/mathscinet/author?authorId="]')) {
    current = current.nextElementSibling;
    if (current && (current.classList.contains('font-weight-bold') || current.tagName === 'HR')) break;
  }
  
  if (current) {
    const authorLinks = Array.from(current.querySelectorAll('a[href*="/mathscinet/author?authorId="]'));
    authors = authorLinks.map(a => cleanAuthorName(a.textContent));
  }

  return { title: title.replace(/\.$/, ''), authors, localMRNumber, injectionPoint: mrLink };
}

// Extract metadata from a standalone article page
function getArticleMetadata() {
  let title = "";
  let authors = [];
  let localMRNumber = "";
  let injectionPoint = null;

  const mrEl = document.querySelector('[data-testid="article-page-mr-number"]') || 
               document.querySelector('.MR + span') ||
               Array.from(document.querySelectorAll('span, h1, h2, strong')).find(el => /MR\d{7}/.test(el.textContent));

  if (mrEl) {
    const m = mrEl.textContent.match(/MR\d+/);
    if (m) localMRNumber = m[0];
    else if (mrEl.textContent.match(/^\d{7}$/)) localMRNumber = "MR" + mrEl.textContent.trim();
  }

  const titleSpan = document.querySelector('span.font-weight-bold.right-space') || 
                  document.querySelector('.bibliography span.font-weight-bold') ||
                  document.querySelector('.bibliography strong');
  
  if (titleSpan) title = titleSpan.textContent.trim();

  const biblio = document.querySelector('.bibliography');
  if (biblio && title) {
    const bibText = biblio.textContent;
    const titleIndex = bibText.indexOf(title);
    if (titleIndex > 10) {
      authors = bibText.substring(0, titleIndex).split(/[;]|\band\b/).map(s => cleanAuthorName(s)).filter(s => s.length > 2 && !s.includes('MR'));
    }
  }
  
  if (authors.length === 0) {
    authors = Array.from(document.querySelectorAll('a[href*="authorId="], a[href*="/mathscinet/author?"]')).map(a => cleanAuthorName(a.textContent));
  }

  injectionPoint = document.querySelector('.text-right.float-right.mt-0.pt-0.d-none.d-md-block') || 
                   document.querySelector('#article-button-group') ||
                   document.querySelector('button[data-testid="article-page-cite-button"]')?.parentElement ||
                   document.querySelector('.headline');

  return { title: title.replace(/\.$/, ''), authors, localMRNumber, injectionPoint };
}

async function searchOpenAlex(title) {
  if (!title) return [];
  const url = `https://api.openalex.org/works?filter=display_name.search:${encodeURIComponent(title)}&per_page=5`;
  
  const dataText = await callBackground(url, "FETCH_OPENALEX");
  if (!dataText) return [];
  
  try {
    const data = JSON.parse(dataText);
    const candidates = [];
    
    for (const work of data.results) {
      let arxivUrl = "";
      if (work.ids && work.ids.arxiv) {
        arxivUrl = work.ids.arxiv;
      } else if (work.locations) {
        const loc = work.locations.find(l => 
          (l.source && l.source.display_name === "arXiv") || 
          (l.landing_page_url && l.landing_page_url.includes("arxiv.org"))
        );
        if (loc) arxivUrl = loc.landing_page_url || loc.pdf_url;
      }
      
      if (arxivUrl) {
        arxivUrl = arxivUrl.replace(/^http:/, "https:");
        arxivUrl = arxivUrl.replace("pdf/", "abs/").replace(".pdf", "");
        candidates.push(arxivUrl);
      }
    }
    return candidates;
  } catch (e) {
    log("OpenAlex Parse Error:", e);
    return [];
  }
}

let activeInjection = false;
let pendingInjection = false;
async function insertArXivLinks() {
  if (activeInjection) {
    pendingInjection = true;
    return;
  }
  activeInjection = true;
  pendingInjection = false;

  try {
    log("insertArXivLinks() starting...");
    
    const isSearchPage = location.href.includes('/publications-search') || location.href.includes('/search/publications');
    
    if (isSearchPage) {
      const headers = Array.from(document.querySelectorAll('div.font-weight-bold')).filter(d => d.querySelector('a[href*="/mathscinet/article?mr="]') && d.textContent.includes('MR'));
      log(`Found ${headers.length} publication headers. Processing in PARALLEL...`);
      
      const tasks = headers.map(async (header) => {
        if (header.querySelector('.arxiv-link')) return;
        
        const metadata = getSearchItemMetadata(header);
        if (metadata && metadata.title && metadata.localMRNumber) {
          const candidates = await searchOpenAlex(metadata.title);
          for (const arxivUrl of candidates) {
            const verified = await verifyAndInject(arxivUrl, metadata.injectionPoint, metadata.localMRNumber, metadata.title, false);
            if (verified) break;
          }
        }
      });
      
      await Promise.all(tasks);
    } else if (location.href.includes('/article?mr=')) {
      let metadata = getArticleMetadata();
      let retries = 15;
      while (retries > 0 && (!metadata.title || !metadata.localMRNumber)) {
        await new Promise(r => setTimeout(r, 1000));
        metadata = getArticleMetadata();
        retries--;
      }

      if (metadata.title && metadata.localMRNumber && !document.querySelector('.arxiv-link')) {
        const candidates = await searchOpenAlex(metadata.title);
        for (const arxivUrl of candidates) {
          const verified = await verifyAndInject(arxivUrl, metadata.injectionPoint, metadata.localMRNumber, metadata.title, true);
          if (verified) break;
        }
      }
    }
  } catch (error) {
    console.error("MathSciNet ArXiv Links Error:", error);
  } finally {
    activeInjection = false;
    if (pendingInjection) {
      pendingInjection = false;
      void insertArXivLinks();
    }
  }
}

async function verifyAndInject(url, injectionPoint, localMRNumber, localTitle, isLargeBtn = false) {
  if (!url || !injectionPoint || (isLargeBtn && document.querySelector('.arxiv-link')) || (!isLargeBtn && injectionPoint.parentElement.querySelector('.arxiv-link'))) return false;

  try {
    const absHtml = await callBackground(url, "FETCH_ARXIV");
    if (!absHtml) return false;

    const doc = new DOMParser().parseFromString(absHtml, "text/html");
    const arxivTitleEl = doc.querySelector('h1.title') || doc.querySelector('.title');
    const arxivTitle = arxivTitleEl ? arxivTitleEl.textContent.replace(/^Title:/, '').trim() : "NOT_FOUND";
    
    const arxivAuthorEls = Array.from(doc.querySelectorAll('div.authors a') || doc.querySelectorAll('.authors a'));
    const lastNames = arxivAuthorEls.map(a => a.textContent.trim().split(' ').pop());

    if (arxivTitle === "NOT_FOUND") return false;

    if (!areTitlesSimilar(arxivTitle, localTitle)) {
        return false;
    }

    const mrefUrl = `https://www.ams.org/mrlookup?ti=${encodeURIComponent(arxivTitle)}&au=${encodeURIComponent(lastNames.slice(0, 3).join(' and '))}`;
    const mrefHtml = await callBackground(mrefUrl, "FETCH_MREF");
    const mrStrip = localMRNumber.replace("MR", "");
    let verified = mrefHtml && mrefHtml.includes(mrStrip);

    if (!verified && areTitlesSimilar(arxivTitle, localTitle)) {
      verified = true;
    }

    if (verified) {
      const arxivBtn = document.createElement('a');
      arxivBtn.href = url;
      arxivBtn.target = '_blank';
      arxivBtn.className = 'arxiv-link';
      arxivBtn.textContent = 'arXiv';
      
      if (isLargeBtn) {
        arxivBtn.className += ' btn btn-outline-primary btn-sm ml-1 mb-1';
        arxivBtn.style.fontWeight = 'bold';
        arxivBtn.style.marginLeft = '5px';
        injectionPoint.appendChild(arxivBtn);
      } else {
        // Search result badge - Positioned to the LEFT of MR number
        arxivBtn.style.color = '#fff';
        arxivBtn.style.backgroundColor = '#f0ad4e';
        arxivBtn.style.padding = '1px 5px';
        arxivBtn.style.borderRadius = '3px';
        arxivBtn.style.fontSize = '0.7rem';
        arxivBtn.style.marginRight = '8px';
        arxivBtn.style.verticalAlign = 'middle';
        arxivBtn.style.textDecoration = 'none';
        arxivBtn.style.fontWeight = 'normal';
        
        // Inject BEFORE the injectionPoint (the MR link)
        injectionPoint.parentNode.insertBefore(arxivBtn, injectionPoint);
      }
      return true;
    }
  } catch (e) {
    log("Verification exception:", e);
  }
  return false;
}

function processReferences() {
  document.querySelectorAll('li').forEach(li => {
    const regex = /(?:https?:\/\/arxiv\.org\/abs\/|arXiv:)([A-Za-z\.\-\/]*[0-9]{4}\.?[0-9]*)/g;
    if (regex.test(li.innerHTML) && !li.querySelector('a[href*="arxiv.org"]')) {
      li.innerHTML = li.innerHTML.replace(regex, '<a href="https://arxiv.org/abs/$1">arXiv:$1</a>');
    }
  });
}

let lastUrl = location.href;
let lastPageSignature = "";

function getSearchPageSignature() {
  const mrLinks = Array.from(document.querySelectorAll('a[href*="/mathscinet/article?mr="]'));
  if (mrLinks.length === 0) return "";
  return mrLinks.map((link) => {
    const href = link.getAttribute('href') || '';
    const match = href.match(/mr=([^&]+)/i);
    if (match) return match[1];
    const text = (link.textContent || '').trim();
    const textMatch = text.match(/MR?\d+/i);
    return textMatch ? textMatch[0] : text;
  }).join('|');
}

function main() {
  log("main() triggered.");
  insertArXivLinks();
  processReferences();
}

const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastPageSignature = "";
    main();
  } else if (location.href.includes('/publications-search') || location.href.includes('/search/publications')) {
    // Detect pagination even when result count is unchanged
    const signature = getSearchPageSignature();
    if (signature && signature !== lastPageSignature) {
      lastPageSignature = signature;
      main();
    }
  } else if (!document.querySelector('.arxiv-link')) {
    if (!activeInjection) main();
  }
});

function init() {
  if (window.self !== window.top) return;
  main();
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', main);
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastPageSignature = "";
      main();
    }
  }, 1000); // Reduced from 4000ms to 1000ms for faster pagination detection
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.type === "TRIGGER_SEARCH") main();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
