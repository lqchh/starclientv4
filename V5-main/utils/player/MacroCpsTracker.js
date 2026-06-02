const WINDOW_MS = 1000;

class MacroClickTracker {
    constructor() {
        this.clicks = {
            left: [],
            right: [],
            middle: [],
        };
    }

    record(button = 'left') {
        const normalized = String(button || 'left').toLowerCase();
        const key = normalized === 'right' ? 'right' : normalized === 'middle' ? 'middle' : 'left';
        this.clicks[key].push(Date.now());
        this.prune(key);
    }

    prune(button) {
        const now = Date.now();
        const list = this.clicks[button];
        while (list.length > 0 && now - list[0] > WINDOW_MS) {
            list.shift();
        }
    }

    get(button = 'left') {
        const normalized = String(button || 'left').toLowerCase();
        const key = normalized === 'right' ? 'right' : normalized === 'middle' ? 'middle' : 'left';
        this.prune(key);
        return this.clicks[key].length;
    }

    getLeft() {
        return this.get('left');
    }

    getRight() {
        return this.get('right');
    }

    getMiddle() {
        return this.get('middle');
    }
}

export const MacroCpsTracker = new MacroClickTracker();
