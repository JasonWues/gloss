// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const stored = vi.hoisted(() => new Map());
vi.mock('../../../../utils/store', () => ({
    store: {
        get: async (key) => stored.get(key),
        set: async (key, value) => void stored.set(key, value),
        has: async (key) => stored.has(key),
        delete: async (key) => void stored.delete(key),
        save: async () => {},
        reload: async () => {},
    },
    initStore: async () => {},
}));

const listeners = vi.hoisted(() => new Map());
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event, handler) => {
        listeners.set(event, handler);
        return () => listeners.delete(event);
    },
    emit: async () => {},
}));

vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
    unregister: vi.fn(async () => {}),
    isRegistered: vi.fn(async () => false),
}));

const { mockIPC, clearMocks } = await import('@tauri-apps/api/mocks');
await import('../../../../i18n');
const { default: Hotkey } = await import('./index');

beforeEach(() => {
    stored.clear();
    stored.set('hotkey_suppressed_processes', []);
    listeners.clear();
    mockIPC((cmd, args) => {
        if (cmd === 'get_hotkey_suppression_status') return false;
        if (cmd === 'list_running_processes') {
            return [
                { name: 'game.exe', pids: [101] },
                { name: 'photoshop.exe', pids: [202, 203] },
                { name: 'browser.exe', pids: [301, 302, 303] },
            ];
        }
        if (cmd === 'update_hotkey_suppressed_processes') {
            return [...new Set(args.processNames.map((name) => name.trim().toLowerCase()))].sort();
        }
        return null;
    });
});

afterEach(async () => {
    cleanup();
    await Promise.resolve();
    clearMocks();
    vi.restoreAllMocks();
});

describe('process-based hotkey suppression settings', () => {
    it('saves the process list immediately and follows backend status events', async () => {
        render(<Hotkey />);
        const field = await screen.findByRole('textbox', { name: 'Suspend while these apps run' });
        expect(screen.getByRole('status')).toHaveTextContent('Gloss shortcuts are active');

        fireEvent.change(field, { target: { value: 'Game.EXE\n\ngame.exe\nzed.exe' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(stored.get('hotkey_suppressed_processes')).toEqual(['game.exe', 'zed.exe']));
        expect(field).toHaveValue('game.exe\nzed.exe');

        await act(async () => {
            listeners.get('hotkey_suppression_changed')?.({ payload: true });
        });
        expect(screen.getByRole('status')).toHaveTextContent('Gloss shortcuts are suspended');

        await act(async () => {
            listeners.get('hotkey_suppression_changed')?.({ payload: false });
        });
        expect(screen.getByRole('status')).toHaveTextContent('Gloss shortcuts are active');
    });

    it('opens a searchable process picker and adds selected processes', async () => {
        render(<Hotkey />);
        const field = await screen.findByRole('textbox', { name: 'Suspend while these apps run' });
        fireEvent.change(field, { target: { value: 'manual.exe' } });
        fireEvent.click(screen.getByRole('button', { name: 'Choose running apps' }));

        expect(await screen.findByRole('checkbox', { name: /game\.exe/ })).toBeInTheDocument();
        expect(screen.getByText('2 instances')).toBeInTheDocument();

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search process names' }), {
            target: { value: 'photo' },
        });
        expect(screen.queryByRole('checkbox', { name: /game\.exe/ })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('checkbox', { name: /photoshop\.exe/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Add selected' }));

        await waitFor(() => expect(stored.get('hotkey_suppressed_processes')).toEqual(['manual.exe', 'photoshop.exe']));
        expect(screen.getByRole('textbox', { name: 'Suspend while these apps run' })).toHaveValue(
            'manual.exe\nphotoshop.exe'
        );
    });

    it('renders the new section without missing translation keys', async () => {
        const { container } = render(<Hotkey />);
        expect(await screen.findByRole('textbox', { name: 'Suspend while these apps run' })).toHaveValue('');
        expect(container.textContent).not.toMatch(/(config|common)\.[a-z_0-9]+\.[a-z_0-9]+/i);
    });
});
