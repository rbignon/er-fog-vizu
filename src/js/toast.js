// ============================================================
// TOAST - Non-intrusive notification system
// ============================================================

const TOAST_DURATION = 5000;
const TOAST_DURATION_LONG = 8000;

let container = null;

function getContainer() {
    if (!container) {
        container = document.getElementById('toast-container');
    }
    return container;
}

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {object} options - Options: type ('info'|'error'|'warning'), duration (ms)
 */
export function show(message, options = {}) {
    const { type = 'info', duration = TOAST_DURATION } = options;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-message">${message}</span>
        <button class="toast-close">&times;</button>
    `;

    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => removeToast(toast));

    getContainer().appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('toast-visible');
    });

    // Auto-remove
    if (duration > 0) {
        setTimeout(() => removeToast(toast), duration);
    }

    return toast;
}

function removeToast(toast) {
    if (!toast || !toast.parentNode) return;

    toast.classList.remove('toast-visible');
    toast.classList.add('toast-hiding');

    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 300);
}

// Convenience methods
export function error(message) {
    return show(message, { type: 'error', duration: TOAST_DURATION_LONG });
}

export function warning(message) {
    return show(message, { type: 'warning' });
}

export function info(message) {
    return show(message, { type: 'info' });
}
