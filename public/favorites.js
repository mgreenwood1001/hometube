let pendingRemoveFilename = null;

function setUiStatus(id, message, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = message || '';
    el.hidden = !text;
    el.textContent = text;
    el.classList.toggle('is-error', Boolean(isError && text));
}

function copyTextWithTextarea(text) {
    return new Promise((resolve, reject) => {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:0;left:-9999px';
        document.body.appendChild(area);
        area.focus();
        area.select();
        try {
            const ok = document.execCommand('copy');
            area.remove();
            ok ? resolve() : reject(new Error('Copy failed'));
        } catch (error) {
            area.remove();
            reject(error);
        }
    });
}

function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).catch(() => copyTextWithTextarea(text));
    }
    return copyTextWithTextarea(text);
}

function copyPageLink(button) {
    const url = window.location.href;
    const original = button ? button.textContent : '';
    copyTextToClipboard(url).then(() => {
        if (!button) return;
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = original; }, 1400);
    }).catch(() => {
        if (!button) return;
        button.textContent = 'Copy failed';
        setTimeout(() => { button.textContent = original; }, 1600);
    });
}

function favoriteIconSvg() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12.1 21.35 10.6 20C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.6 11.54l-1.3 1.31z"/></svg>`;
}

function applyFavoriteState(button, favorited) {
    if (!button) return;
    button.classList.toggle('is-favorite', !!favorited);
    button.setAttribute('aria-pressed', favorited ? 'true' : 'false');
    button.title = favorited ? 'Remove from favorites' : 'Add to favorites';
    const label = button.querySelector('.favorite-label');
    if (label) {
        label.textContent = favorited ? 'Favorited' : 'Favorite';
    }
}

function updateFavoriteCount(count) {
    const badge = document.getElementById('favoriteCountBadge');
    if (!badge || count == null) return;
    badge.textContent = count;
    badge.hidden = Number(count) <= 0;
}

async function toggleFavorite(button) {
    if (!button) return;
    const filename = button.getAttribute('data-filename');
    if (!filename) return;
    button.disabled = true;
    try {
        const response = await fetch('/api/favorites/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ filename })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Could not update favorite');
        }
        applyFavoriteState(button, data.favorited);
        updateFavoriteCount(data.favoriteCount);
        document.querySelectorAll('.favorite-btn').forEach(other => {
            if (other !== button && other.getAttribute('data-filename') === filename) {
                applyFavoriteState(other, data.favorited);
            }
        });
        if (typeof currentFavorites !== 'undefined' && currentFavorites && !data.favorited && typeof loadVideos === 'function') {
            loadVideos(currentPage, currentStem, currentFilterMode, currentResolution, currentFileType, currentDateFrom, currentDateTo);
        }
    } catch (error) {
        console.error('Favorite toggle failed:', error);
    } finally {
        button.disabled = false;
    }
}

function bindFavoriteButton(buttonId, filename, favorited) {
    const buttons = [];
    const main = document.getElementById(buttonId);
    if (main) buttons.push(main);
    document.querySelectorAll('.favorite-btn').forEach(button => {
        if (!buttons.includes(button)) buttons.push(button);
    });
    buttons.forEach(button => {
        button.setAttribute('data-filename', filename);
        if (button.classList.contains('action-button') && !button.querySelector('.favorite-label')) {
            button.innerHTML = `${favoriteIconSvg()}<span class="favorite-label">Favorite</span>`;
        } else if (!button.querySelector('svg')) {
            button.innerHTML = favoriteIconSvg();
        }
        applyFavoriteState(button, favorited);
        button.hidden = false;
        button.disabled = false;
    });
    pendingRemoveFilename = null;
    const cancel = document.getElementById('cancelRemoveContentButton');
    if (cancel) cancel.hidden = true;
    const removeButton = document.getElementById('removeContentButton');
    if (removeButton) {
        if (removeButton.dataset.defaultLabel) {
            removeButton.textContent = removeButton.dataset.defaultLabel;
        }
        removeButton.setAttribute('data-filename', filename);
        removeButton.disabled = false;
    }
    setUiStatus('removeContentStatus', '');
}

function cancelRemoveCurrentMedia() {
    pendingRemoveFilename = null;
    const button = document.getElementById('removeContentButton');
    if (button && button.dataset.defaultLabel) {
        button.textContent = button.dataset.defaultLabel;
        button.disabled = false;
    }
    const cancel = document.getElementById('cancelRemoveContentButton');
    if (cancel) cancel.hidden = true;
    setUiStatus('removeContentStatus', '');
}

async function removeCurrentMedia(button) {
    const filename = (button && button.getAttribute('data-filename'))
        || document.getElementById('favoriteButton')?.getAttribute('data-filename');
    if (!filename) return;
    const title = document.querySelector('.video-title-large')?.textContent || filename;
    if (button && !button.dataset.defaultLabel) {
        button.dataset.defaultLabel = button.textContent.trim();
    }
    const cancel = document.getElementById('cancelRemoveContentButton');
    if (pendingRemoveFilename !== filename) {
        pendingRemoveFilename = filename;
        if (button) button.textContent = 'Confirm delete';
        if (cancel) cancel.hidden = false;
        setUiStatus('removeContentStatus', `Click Confirm delete to permanently remove "${title}". This cannot be undone.`);
        return;
    }
    pendingRemoveFilename = null;
    if (cancel) cancel.hidden = true;
    if (button) button.disabled = true;
    setUiStatus('removeContentStatus', 'Removing…');
    try {
        const response = await fetch(`/api/file/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || 'Could not remove file');
        }
        window.location.href = '/';
    } catch (error) {
        console.error('Remove failed:', error);
        if (button) {
            button.disabled = false;
            if (button.dataset.defaultLabel) button.textContent = button.dataset.defaultLabel;
        }
        setUiStatus('removeContentStatus', error.message, true);
    }
}

function favoriteButtonHtml(filename, favorited, withLabel = false) {
    const pressed = favorited ? 'true' : 'false';
    const active = favorited ? ' is-favorite' : '';
    const title = favorited ? 'Remove from favorites' : 'Add to favorites';
    const label = withLabel ? `<span class="favorite-label">${favorited ? 'Favorited' : 'Favorite'}</span>` : '';
    const safeName = String(filename)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
    return `<button type="button" class="favorite-btn${active}${withLabel ? ' action-button' : ''}" data-filename="${safeName}" aria-pressed="${pressed}" title="${title}" onclick="event.stopPropagation(); toggleFavorite(this)">${favoriteIconSvg()}${label}</button>`;
}
