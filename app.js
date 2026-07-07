/**
 * Our Wedding Gallery - Core JS Engine
 * Handles Password Gate, Dynamic Rendering, Masonry Grid, Tab Filters, and Immersive Lightbox.
 */

// ==========================================================================
// CONFIGURATION
// ==========================================================================
// GALLERY_CONFIG will be dynamically loaded from gallery-config.json during initialization
let GALLERY_CONFIG = {};

// Helper to resolve the correct URL for an asset based on its collection's bucket URL mapping
function resolveMediaUrl(collection, relativePath) {
    if (!relativePath) return "";
    const bucketUrl = GALLERY_CONFIG.r2BucketUrls && GALLERY_CONFIG.r2BucketUrls[collection];
    if (bucketUrl && bucketUrl !== "your-wedding-public-r2-url" && bucketUrl !== "your-family-trip-public-r2-url") {
        return `${bucketUrl.replace(/\/$/, '')}/${relativePath}`;
    }
    return relativePath;
}

// Gallery state
let galleryItems = [];
let filteredItems = [];
let activeIndex = -1;
let currentRenderIndex = 0;
let currentCollection = "";
const ITEMS_PER_PAGE = 30;

// ==========================================================================
// INITIALIZATION & LOGIN LOGIC
// ==========================================================================
document.addEventListener("DOMContentLoaded", async () => {
    await initApp();
});

async function initApp() {
    // Load config dynamically from gallery-config.json
    try {
        const response = await fetch("gallery-config.json");
        if (!response.ok) throw new Error("Failed to load configuration");
        GALLERY_CONFIG = await response.json();
    } catch (err) {
        console.error("Error loading gallery-config.json:", err);
        const errorMsg = document.getElementById("password-error");
        if (errorMsg) {
            errorMsg.textContent = "Error loading configuration. Please ensure gallery-config.json is present.";
        }
        return;
    }

    // Apply dynamic gallery configuration branding
    document.title = GALLERY_CONFIG.title;
    document.getElementById("gate-title").textContent = GALLERY_CONFIG.title;

    const passwordGate = document.getElementById("password-gate");
    const galleryContainer = document.getElementById("gallery-container");
    const passwordForm = document.getElementById("password-form");
    const passwordInput = document.getElementById("password-input");
    const passwordError = document.getElementById("password-error");
    const logoutBtn = document.getElementById("logout-btn");

    // Check if already unlocked with valid credentials
    if (getSessionAccess() !== null) {
        unlockGallery();
    } else {
        // Show login screen
        passwordGate.classList.remove("gate-inactive");
        passwordGate.classList.add("gate-active");
        passwordInput.focus();
    }

    // Handle Password Submission
    passwordForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const inputPass = passwordInput.value;
        const inputHash = await sha256(inputPass);

        // Fetch access configuration list
        let access = GALLERY_CONFIG.accessRules[inputHash];

        if (access) {
            localStorage.setItem("gallery_unlocked_hash", inputHash);
            passwordError.textContent = "";
            unlockGallery();
        } else {
            // Failure
            passwordError.textContent = "Incorrect password. Please try again.";
            passwordInput.value = "";
            passwordInput.focus();
        }
    });

    // Handle Logout / Lock
    const lockHandler = () => {
        localStorage.removeItem("gallery_unlocked_hash");
        window.location.reload();
    };
    logoutBtn.addEventListener("click", lockHandler);
    const portalLockBtn = document.getElementById("portal-lock-btn");
    if (portalLockBtn) {
        portalLockBtn.addEventListener("click", lockHandler);
    }

    // Setup event delegation for tab filters (avoids inline onclick event handlers)
    const tabsContainer = document.getElementById("filter-tabs");
    tabsContainer.addEventListener("click", (e) => {
        const btn = e.target.closest(".tab-btn");
        if (btn) {
            const category = btn.dataset.category;
            filterCategory(category);
        }
    });

    // Scroll down to gallery from hero section
    const scrollBtn = document.getElementById("hero-scroll-btn");
    if (scrollBtn) {
        scrollBtn.addEventListener("click", () => {
            const gridSection = document.getElementById("gallery-grid-section");
            if (gridSection) {
                gridSection.scrollIntoView({ behavior: "smooth" });
            }
        });
    }

    // Setup Collection Selection Dropdown Click Toggle
    const dropdownBtn = document.getElementById("collection-select-btn");
    const dropdown = document.getElementById("collection-dropdown");
    if (dropdownBtn && dropdown) {
        dropdownBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const expanded = dropdownBtn.getAttribute("aria-expanded") === "true";
            dropdownBtn.setAttribute("aria-expanded", !expanded);
            dropdown.classList.toggle("hidden");
        });

        // Close dropdown when clicking outside
        document.addEventListener("click", () => {
            dropdownBtn.setAttribute("aria-expanded", "false");
            dropdown.classList.add("hidden");
        });
    }

    // Bind route changes (hashchange event)
    window.addEventListener("hashchange", handleRouteChanged);

    // Setup Lightbox Event Listeners
    setupLightbox();
}

// Get active session access rules
function getSessionAccess() {
    const hash = localStorage.getItem("gallery_unlocked_hash");
    if (!hash) return null;
    return GALLERY_CONFIG.accessRules[hash] || null;
}

// Unlock the interface and load data
function unlockGallery() {
    const passwordGate = document.getElementById("password-gate");
    const galleryContainer = document.getElementById("gallery-container");

    // Fade out gate and fade in gallery
    passwordGate.classList.remove("gate-active");
    passwordGate.classList.add("gate-inactive");
    galleryContainer.classList.remove("hidden");

    loadGalleryData();
}

// SHA-256 helper function using browser native Crypto API
async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ==========================================================================
// DATA LOADING & ROUTING
// ==========================================================================
async function loadGalleryData() {
    const loader = document.getElementById("gallery-loader");
    loader.classList.remove("hidden");

    try {
        // Fetch the JSON catalog (from local website root)
        const jsonUrl = 'gallery-data.json';
        const response = await fetch(jsonUrl);
        if (!response.ok) throw new Error("Catalog load failed");

        const rawData = await response.json();

        // Retrieve session access level configurations
        const access = getSessionAccess();
        if (!access) {
            // Force lock on invalid/expired credentials session
            localStorage.removeItem("gallery_unlocked_hash");
            window.location.reload();
            return;
        }

        // Cryptographically prune galleryItems to keep ONLY authorized collections.
        // Unauthorized media entries never hit the grid DOM or lightbox arrays.
        if (access === "*") {
            galleryItems = rawData;
        } else {
            galleryItems = rawData.filter(item => access.includes(item.collection));
        }

        // Get unique list of collections (ignore folders starting with dots or empty)
        const collections = [...new Set(galleryItems.map(item => item.collection).filter(Boolean))];

        if (collections.length === 0) {
            document.getElementById("empty-state").innerHTML = `
                <p style="color: var(--color-error)">You do not have access to any active collections. Please check your credentials.</p>
            `;
            document.getElementById("empty-state").classList.remove("hidden");
            return;
        }

        // Render the dynamic dropdown links in header
        renderCollectionDropdown(collections);

        // Render appropriate view based on initial route
        renderRouteView();

        // Setup Infinite Scroll Observer
        setupInfiniteScroll();

    } catch (error) {
        console.error("Error loading gallery data:", error);
        document.getElementById("empty-state").innerHTML = `
            <p style="color: var(--color-error)">Failed to load gallery. Make sure R2 CORS policies allow access and gallery-data.json exists.</p>
        `;
        document.getElementById("empty-state").classList.remove("hidden");
    } finally {
        loader.classList.add("hidden");
    }
}
// Extract the collection route from the URL hash (e.g. #/wedding -> wedding)
function getRoute() {
    const hash = window.location.hash || "";
    if (hash.startsWith("#/")) {
        return decodeURIComponent(hash.substring(2));
    }
    return "";
}

// Handle route change when URL hash changes
function handleRouteChanged() {
    renderRouteView();
}

// Switches template views based on active hash path (empty shows portal, path shows collection)
function renderRouteView() {
    const activeRoute = getRoute();
    const portal = document.getElementById("homepage-portal");
    const collectionView = document.getElementById("collection-view");
    const collections = [...new Set(galleryItems.map(item => item.collection).filter(Boolean))];
    if (collections.length === 0) collections.push("General");

    if (activeRoute === "") {
        // Show Homepage Portal
        portal.classList.remove("hidden");
        collectionView.classList.add("hidden");

        // Render Portal Cards
        renderHomepagePortal(collections);

        // Update browser metadata for portal home
        document.title = GALLERY_CONFIG.title;
    } else {
        // Show Collection Subpage
        portal.classList.add("hidden");
        collectionView.classList.remove("hidden");

        // Load this collection if valid, otherwise go home
        if (collections.includes(activeRoute)) {
            switchCollection(activeRoute);
        } else {
            window.location.hash = "";
        }
    }
}

// Render dynamic homepage collections cards
function renderHomepagePortal(collections) {
    const portalGrid = document.getElementById("portal-grid");
    if (!portalGrid) return;

    portalGrid.innerHTML = collections.map(col => {
        const colItems = galleryItems.filter(item => item.collection === col);
        const firstImg = colItems.find(item => item.type === "image");
        const bgUrl = firstImg ? resolveMediaUrl(col, firstImg.optimized) : '';
        const displayName = GALLERY_CONFIG.collectionNames[col] || capitalizeWords(col.replace(/-/g, ' '));

        return `
            <a href="#/${col}" class="portal-card" style="background-image: url('${bgUrl}')">
                <div class="portal-card-overlay"></div>
                <div class="portal-card-content">
                    <h2 class="portal-card-title">${displayName}</h2>
                    <span class="portal-card-count">${colItems.length} Photos & Videos</span>
                    <span class="portal-card-link">Explore Collection &rarr;</span>
                </div>
            </a>
        `;
    }).join('');
}

// Redraw dropdown with active state highlighted
function renderCollectionDropdown(collections) {
    const dropdown = document.getElementById("collection-dropdown");
    if (!dropdown) return;

    const activeRoute = getRoute();

    dropdown.innerHTML = collections.map(col => {
        const displayName = GALLERY_CONFIG.collectionNames[col] || capitalizeWords(col.replace(/-/g, ' '));
        const isActive = col === activeRoute;
        return `<a href="#/${col}" class="collection-link ${isActive ? 'active' : ''}" role="option" aria-selected="${isActive}">${displayName}</a>`;
    }).join('');
}

// Switch between collections (e.g. wedding -> family-trip)
function switchCollection(col) {
    currentCollection = col;
    const collections = [...new Set(galleryItems.map(item => item.collection).filter(Boolean))];
    if (collections.length === 0) collections.push("General");

    // Update branding headers dynamically
    const displayName = GALLERY_CONFIG.collectionNames[col] || capitalizeWords(col.replace(/-/g, ' '));
    document.title = `${displayName} | ${GALLERY_CONFIG.title}`;
    document.getElementById("logo-title").textContent = displayName;
    document.getElementById("hero-title").textContent = displayName;

    // Customise subtitle for specific folders if desired, or default to general subtitle
    document.getElementById("hero-date").textContent = col === "wedding" ? GALLERY_CONFIG.subtitle : "Memories & Highlights";

    // Update cover page background image using the first image from this collection
    const colItems = galleryItems.filter(item => item.collection === col);
    if (colItems.length > 0) {
        const firstImg = colItems.find(item => item.type === "image");
        if (firstImg) {
            const bgUrl = resolveMediaUrl(col, firstImg.original);
            document.getElementById("hero-section").style.backgroundImage = `url('${bgUrl}')`;
        } else {
            document.getElementById("hero-section").style.backgroundImage = 'none';
        }
    } else {
        document.getElementById("hero-section").style.backgroundImage = 'none';
    }

    // Refresh Category Tabs for this collection
    generateCategoryTabs(col);

    // Initial load for this collection (all category filters)
    filterCategory("All");

    // Update highlight states on dropdown selection
    renderCollectionDropdown(collections);
}

// Generate category tabs filtered to the active collection only
function generateCategoryTabs(col) {
    const tabsContainer = document.getElementById("filter-tabs");
    if (!tabsContainer) return;

    const colItems = galleryItems.filter(item => item.collection === col);

    // Get unique categories and their counts within this collection
    const categoriesMap = { "All": colItems.length };
    let hasVideos = false;

    colItems.forEach(item => {
        const cat = item.category || "General";
        categoriesMap[cat] = (categoriesMap[cat] || 0) + 1;
        if (item.type === "video") hasVideos = true;
    });

    if (hasVideos) {
        categoriesMap["Videos"] = colItems.filter(item => item.type === "video").length;
    }

    // Render category tab buttons
    tabsContainer.innerHTML = Object.entries(categoriesMap).map(([name, count]) => {
        if (count === 0) return '';
        const isActive = name === "All" ? "active" : "";
        return `
            <button class="tab-btn ${isActive}" data-category="${name}">
                ${name} <span style="font-size:0.7rem; opacity:0.6; margin-left:2px;">(${count})</span>
            </button>
        `;
    }).join("");
}

// Filter the active media items (within the active collection)
window.filterCategory = function (category) {
    const colItems = galleryItems.filter(item => item.collection === currentCollection);

    // Reset tabs UI selection state
    const buttons = document.querySelectorAll("#filter-tabs .tab-btn");
    buttons.forEach(btn => {
        // Handle exact name matching for counts
        if (btn.dataset.category === category) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });

    // Apply category filter
    if (category === "All") {
        filteredItems = [...colItems];
    } else if (category === "Videos") {
        filteredItems = colItems.filter(item => item.type === "video");
    } else {
        filteredItems = colItems.filter(item => item.category === category);
    }

    // Reset pagination and grid layout
    const grid = document.getElementById("gallery-grid");
    grid.innerHTML = "";
    currentRenderIndex = 0;

    // Check empty state
    const emptyState = document.getElementById("empty-state");
    if (filteredItems.length === 0) {
        emptyState.classList.remove("hidden");
    } else {
        emptyState.classList.add("hidden");
        renderNextBatch();
    }
};

// Render next batch of items (Infinite Scroll)
function renderNextBatch() {
    const grid = document.getElementById("gallery-grid");
    const end = Math.min(currentRenderIndex + ITEMS_PER_PAGE, filteredItems.length);

    if (currentRenderIndex >= filteredItems.length) return;

    const fragment = document.createDocumentFragment();

    for (let i = currentRenderIndex; i < end; i++) {
        const item = filteredItems[i];
        const card = document.createElement("div");
        card.className = "gallery-item";
        card.dataset.index = i;

        // Format URLs
        const isVideo = item.type === "video";
        const previewUrl = isVideo
            ? resolveMediaUrl(item.collection, item.thumbnail)
            : resolveMediaUrl(item.collection, item.optimized);
        const downloadUrl = resolveMediaUrl(item.collection, item.original);
        const hasPreview = isVideo ? !!item.thumbnail : !!item.optimized;

        // Apply performance guides:
        // - Eager loading + fetchpriority="high" for the first 2 visible images (above the fold) to improve LCP.
        // - Lazy loading for all subsequent items.
        // - Explicit width/height from metadata to prevent Cumulative Layout Shift (CLS).
        const isEager = i < 2;
        const imgWidth = item.width || 400;
        const imgHeight = item.height || 300;

        // Grid card inner HTML
        let innerHtml = `
            <div class="gallery-media-wrapper" style="aspect-ratio: ${item.aspect_ratio || '1'};">
        `;

        if (item.type === "video") {
            if (hasPreview) {
                if (isEager) {
                    innerHtml += `<img src="${previewUrl}" alt="${item.name}" width="${imgWidth}" height="${imgHeight}" fetchpriority="high" class="loaded">`;
                } else {
                    innerHtml += `<img data-src="${previewUrl}" alt="${item.name}" width="${imgWidth}" height="${imgHeight}" loading="lazy">`;
                }
            } else {
                // Fallback video card
                innerHtml += `<div style="width:100%; height:100%; min-height:180px; background:#faf8f5; display:flex; align-items:center; justify-content:center;"></div>`;
            }
            innerHtml += `
                <div class="video-badge">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </div>
            `;
        } else {
            if (isEager) {
                innerHtml += `<img src="${previewUrl}" alt="${item.name}" width="${imgWidth}" height="${imgHeight}" fetchpriority="high" class="loaded">`;
            } else {
                innerHtml += `<img data-src="${previewUrl}" alt="${item.name}" width="${imgWidth}" height="${imgHeight}" loading="lazy">`;
            }
        }

        // Overlay with quick download button matching reference layouts
        innerHtml += `
                <div class="gallery-hover-overlay">
                    <a class="quick-download-btn" href="${downloadUrl}" download="${item.name}" target="_blank" title="Download Photo">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    </a>
                </div>
            </div>
        `;

        card.innerHTML = innerHtml;

        // Add click behavior: open Lightbox unless quick download is clicked
        card.addEventListener("click", (e) => {
            if (e.target.closest(".quick-download-btn")) {
                e.stopPropagation(); // stop lightbox from opening
            } else {
                openLightbox(i);
            }
        });
        fragment.appendChild(card);
    }

    grid.appendChild(fragment);
    currentRenderIndex = end;

    // Trigger IntersectionObserver for images
    lazyLoadImages();
}

// Clean ordering numbers or hashes from filename for presentation
function cleanName(filename) {
    let name = filename.split('.')[0]; // strip extension
    // Strip hashes like "f1a2b3c4_myphoto" -> "myphoto"
    const hashMatch = name.match(/^[a-f0-9]{12}_(.*)$/);
    if (hashMatch) {
        name = hashMatch[1];
    }
    // Replace underscores/dashes with spaces and capitalize
    return name.replace(/[_-]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

// Native lazy loading with fade-in animation
function lazyLoadImages() {
    const lazyImages = document.querySelectorAll(".gallery-item img:not(.loaded)");

    if ("IntersectionObserver" in window) {
        const imageObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const image = entry.target;
                    image.src = image.dataset.src;
                    image.addEventListener("load", () => {
                        image.classList.add("loaded");
                    });
                    observer.unobserve(image);
                }
            });
        });

        lazyImages.forEach(image => imageObserver.observe(image));
    } else {
        // Fallback for older browsers
        lazyImages.forEach(image => {
            image.src = image.dataset.src;
            image.classList.add("loaded");
        });
    }
}

// Setup scroll observer for infinite pagination
function setupInfiniteScroll() {
    const sentinel = document.createElement("div");
    sentinel.id = "infinite-scroll-sentinel";
    sentinel.style.height = "10px";
    document.querySelector(".gallery-wrapper").appendChild(sentinel);

    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && filteredItems.length > currentRenderIndex) {
            renderNextBatch();
        }
    }, {
        rootMargin: "300px" // Load ahead before the user reaches the bottom
    });

    observer.observe(sentinel);
}

// ==========================================================================
// IMMERSIVE LIGHTBOX CONTROLS (Using Native HTML5 Dialog API)
// ==========================================================================
function setupLightbox() {
    const lightbox = document.getElementById("lightbox");
    const closeBtn = document.getElementById("lightbox-close-btn");
    const prevBtn = document.getElementById("lightbox-prev-btn");
    const nextBtn = document.getElementById("lightbox-next-btn");

    // Close on click
    closeBtn.addEventListener("click", closeLightbox);

    // Close when clicking overlay backdrop outside the dialog box
    lightbox.addEventListener("click", (e) => {
        const rect = lightbox.getBoundingClientRect();
        const isInDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
            rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
        if (!isInDialog) {
            closeLightbox();
        }
    });

    // Handle native Escape key dismiss on <dialog>
    lightbox.addEventListener("cancel", (e) => {
        e.preventDefault(); // prevent default browser behavior
        closeLightbox();
    });

    // Prev/Next handlers
    prevBtn.addEventListener("click", (e) => { e.stopPropagation(); navigateLightbox(-1); });
    nextBtn.addEventListener("click", (e) => { e.stopPropagation(); navigateLightbox(1); });

    // Keyboard handlers (only active when lightbox is open)
    document.addEventListener("keydown", (e) => {
        if (!lightbox.open) return;

        if (e.key === "ArrowLeft") navigateLightbox(-1);
        else if (e.key === "ArrowRight") navigateLightbox(1);
    });

    // Touch swipe handlers (for mobile)
    let touchStartX = 0;
    let touchEndX = 0;
    const contentArea = document.getElementById("lightbox-content");

    contentArea.addEventListener("touchstart", (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    contentArea.addEventListener("touchend", (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });

    function handleSwipe() {
        const threshold = 55; // minimum swiping distance in pixels
        const deltaX = touchEndX - touchStartX;
        if (deltaX > threshold) {
            navigateLightbox(-1); // swipe right -> show previous
        } else if (deltaX < -threshold) {
            navigateLightbox(1);  // swipe left -> show next
        }
    }
}

function openLightbox(index) {
    const lightbox = document.getElementById("lightbox");
    const mainContainer = document.getElementById("gallery-container");

    // Open modal using native dialog API
    lightbox.showModal();

    // Apply inert to background shell to prevent keyboard tab focus & simplify screen readers
    mainContainer.setAttribute("inert", "");
    document.body.style.overflow = "hidden"; // Prevent background scroll

    updateLightboxMedia(index);
}

function closeLightbox() {
    const lightbox = document.getElementById("lightbox");
    const mainContainer = document.getElementById("gallery-container");
    const content = document.getElementById("lightbox-content");

    // Pause any playing videos before closing
    const activeVideo = content.querySelector("video");
    if (activeVideo) activeVideo.pause();

    // Close native dialog
    lightbox.close();

    // Restore background tab index flow
    mainContainer.removeAttribute("inert");
    document.body.style.overflow = ""; // Re-enable background scroll
    activeIndex = -1;
    content.innerHTML = "";
}

function navigateLightbox(direction) {
    if (filteredItems.length <= 1) return;

    let newIndex = activeIndex + direction;
    if (newIndex < 0) newIndex = filteredItems.length - 1;
    if (newIndex >= filteredItems.length) newIndex = 0;

    updateLightboxMedia(newIndex);
}

function updateLightboxMedia(index) {
    activeIndex = index;
    const item = filteredItems[index];
    const content = document.getElementById("lightbox-content");
    const title = document.getElementById("lightbox-title");
    const category = document.getElementById("lightbox-category");
    const downloadLink = document.getElementById("lightbox-download");

    // Fade out previous content
    content.innerHTML = "";

    // Prepare absolute URLs
    const mediaUrl = resolveMediaUrl(item.collection, item.optimized);
    const downloadUrl = resolveMediaUrl(item.collection, item.original);
    const posterUrl = item.thumbnail ? resolveMediaUrl(item.collection, item.thumbnail) : '';

    let mediaElement;

    if (item.type === "video") {
        mediaElement = document.createElement("video");
        mediaElement.src = mediaUrl;
        if (posterUrl) {
            mediaElement.poster = posterUrl;
        }
        mediaElement.controls = true;
        mediaElement.autoplay = true;
        mediaElement.playsInline = true;
        mediaElement.loop = true;
        mediaElement.classList.add("active-media");
    } else {
        mediaElement = document.createElement("img");
        mediaElement.src = mediaUrl;
        mediaElement.alt = item.name;
        // Trigger smooth reveal on load
        mediaElement.addEventListener("load", () => {
            mediaElement.classList.add("active-media");
        });
    }

    content.appendChild(mediaElement);

    // Update metadata info
    title.textContent = cleanName(item.name);
    category.textContent = item.category || "General";

    // Download link setup
    downloadLink.href = downloadUrl;
    downloadLink.download = item.name;
}

// Helper function to capitalize folder names into readable display titles
function capitalizeWords(str) {
    return str.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
