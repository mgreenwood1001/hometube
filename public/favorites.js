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
    const removeButton = document.getElementById('removeContentButton');
    if (removeButton) {
        removeButton.setAttribute('data-filename', filename);
        removeButton.disabled = false;
    }
}

async function removeCurrentMedia(button) {
    const filename = (button && button.getAttribute('data-filename'))
        || document.getElementById('favoriteButton')?.getAttribute('data-filename');
    if (!filename) return;
    const title = document.querySelector('.video-title-large')?.textContent || filename;
    const confirmed = window.confirm(`Permanently delete "${title}" from disk and remove it from the library? This cannot be undone.`);
    if (!confirmed) return;
    if (button) button.disabled = true;
    const status = document.getElementById('removeContentStatus');
    if (status) {
        status.hidden = true;
        status.textContent = '';
    }
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
        if (button) button.disabled = false;
        if (status) {
            status.hidden = false;
            status.textContent = error.message;
        }
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
