import { unregister, isRegistered } from '@tauri-apps/plugin-global-shortcut';
import { listen } from '@tauri-apps/api/event';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Button, InputGroup, TextArea, TextField } from '@heroui/react';
import React, { useEffect, useRef, useState } from 'react';

import { useConfig } from '../../../../hooks/useConfig';
import { useToastStyle } from '../../../../hooks';
import { osType } from '../../../../utils/env';
import { Section, Row } from '../../components/Section';
import { invoke } from '@tauri-apps/api/core';

import ProcessPicker from './ProcessPicker';

const SUPPRESSION_STATUS_EVENT = 'hotkey_suppression_changed';

const keyMap = {
    Backquote: '`',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Equal: '=',
    Minus: '-',
    Plus: 'PLUS',
    Period: '.',
    Quote: "'",
    Semicolon: ';',
    Slash: '/',
    Backspace: 'Backspace',
    CapsLock: 'Capslock',
    ContextMenu: 'Contextmenu',
    Space: 'Space',
    Tab: 'Tab',
    Convert: 'Convert',
    Delete: 'Delete',
    End: 'End',
    Help: 'Help',
    Home: 'Home',
    PageDown: 'Pagedown',
    PageUp: 'Pageup',
    Escape: 'Esc',
    PrintScreen: 'Printscreen',
    ScrollLock: 'Scrolllock',
    Pause: 'Pause',
    Insert: 'Insert',
    Suspend: 'Suspend',
};

export default function Hotkey() {
    const [selectionTranslate, setSelectionTranslate] = useConfig('hotkey_selection_translate', '');
    const [selectionReplace, setSelectionReplace] = useConfig('hotkey_selection_replace', '');
    const [inputTranslate, setInputTranslate] = useConfig('hotkey_input_translate', '');
    const [ocrRecognize, setOcrRecognize] = useConfig('hotkey_ocr_recognize', '');
    const [ocrTranslate, setOcrTranslate] = useConfig('hotkey_ocr_translate', '');
    const [suppressedProcesses, setSuppressedProcesses] = useConfig('hotkey_suppressed_processes', []);
    const [processText, setProcessText] = useState('');
    const [savingProcesses, setSavingProcesses] = useState(false);
    const [hotkeysSuspended, setHotkeysSuspended] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [runningProcesses, setRunningProcesses] = useState([]);
    const [loadingProcesses, setLoadingProcesses] = useState(false);
    const [addingProcesses, setAddingProcesses] = useState(false);
    const processTextRef = useRef(processText);
    processTextRef.current = processText;

    const { t } = useTranslation();
    const toastStyle = useToastStyle();

    useEffect(() => {
        if (suppressedProcesses !== null) {
            setProcessText(suppressedProcesses.join('\n'));
        }
    }, [suppressedProcesses]);

    useEffect(() => {
        let alive = true;
        invoke('get_hotkey_suppression_status').then((active) => {
            if (alive) setHotkeysSuspended(active);
        });
        const unlisten = listen(SUPPRESSION_STATUS_EVENT, (event) => {
            if (alive) setHotkeysSuspended(event.payload);
        });
        return () => {
            alive = false;
            unlisten.then((stop) => stop()).catch(() => {});
        };
    }, []);

    async function persistProcesses(processNames) {
        const saved = await invoke('update_hotkey_suppressed_processes', { processNames });
        setSuppressedProcesses(saved, true);
        return saved;
    }

    async function saveSuppressedProcesses() {
        setSavingProcesses(true);
        try {
            const processNames = processTextRef.current
                .split(/\r?\n/)
                .map((name) => name.trim())
                .filter(Boolean);
            await persistProcesses(processNames);
            toast.success(t('config.hotkey.suppressed_processes_success'), { style: toastStyle });
        } catch (error) {
            toast.error(`${error}`, { style: toastStyle });
        } finally {
            setSavingProcesses(false);
        }
    }

    async function openProcessPicker() {
        setPickerOpen(true);
        setLoadingProcesses(true);
        try {
            setRunningProcesses(await invoke('list_running_processes'));
        } catch (error) {
            toast.error(`${error}`, { style: toastStyle });
            setPickerOpen(false);
        } finally {
            setLoadingProcesses(false);
        }
    }

    async function addPickedProcesses(names, close) {
        setAddingProcesses(true);
        try {
            // Include text typed but not manually saved yet; picking a process
            // is itself a save action and must not discard that text. Rust
            // normalizes and deduplicates the combined list before persisting.
            const current = processTextRef.current.split(/\r?\n/);
            await persistProcesses([...current, ...names]);
            toast.success(t('config.hotkey.process_picker_success', { count: names.length }), {
                style: toastStyle,
            });
            close();
        } catch (error) {
            toast.error(`${error}`, { style: toastStyle });
        } finally {
            setAddingProcesses(false);
        }
    }

    function keyDown(e, setKey) {
        e.preventDefault();
        if (e.keyCode === 8) {
            setKey('');
        } else {
            let newValue = '';
            if (e.ctrlKey) {
                newValue = 'Ctrl';
            }
            if (e.shiftKey) {
                newValue = `${newValue}${newValue.length > 0 ? '+' : ''}Shift`;
            }
            if (e.metaKey) {
                newValue = `${newValue}${newValue.length > 0 ? '+' : ''}${osType === 'Darwin' ? 'Command' : 'Super'}`;
            }
            if (e.altKey) {
                newValue = `${newValue}${newValue.length > 0 ? '+' : ''}Alt`;
            }
            let code = e.code;
            if (code.startsWith('Key')) {
                code = code.substring(3);
            } else if (code.startsWith('Digit')) {
                code = code.substring(5);
            } else if (code.startsWith('Numpad')) {
                code = 'Num' + code.substring(6);
            } else if (code.startsWith('Arrow')) {
                code = code.substring(5);
            } else if (code.startsWith('Intl')) {
                code = code.substring(4);
            } else if (/F\d+/.test(code)) {
            } else if (keyMap[code] !== undefined) {
                code = keyMap[code];
            } else {
                code = '';
            }
            setKey(`${newValue}${newValue.length > 0 && code.length > 0 ? '+' : ''}${code}`);
        }
    }

    function registerHandler(name, key) {
        isRegistered(key).then((res) => {
            if (res) {
                toast.error(t('config.hotkey.is_register'), { style: toastStyle });
            } else {
                invoke('register_shortcut_by_frontend', {
                    name: name,
                    shortcut: key,
                }).then(
                    () => {
                        toast.success(t('config.hotkey.success'), { style: toastStyle });
                    },
                    (e) => {
                        toast.error(e, { style: toastStyle });
                    }
                );
            }
        });
    }

    return (
        <>
            <Section
                name={t('config.hotkey.section.global')}
                note={t('config.hotkey.section.global_note')}
            >
                <Row
                    label={t('config.hotkey.selection_translate')}
                    desc={t('config.hotkey.selection_translate_desc')}
                >
                    {/* InputGroup, not Input with children: v3's Input renders a real
                        <input>, which is a void element and cannot hold the OK button.
                        `label` is not a v3 Input prop either. It carried the only
                        hint an unset hotkey field ever showed, so it splits in
                        two: aria-label for the accessible name, placeholder for
                        the text -- without the latter the two unbound rows are
                        blank white boxes that say nothing.
                        `readOnly` because the value is driven by onKeyDown, and React
                        warns on a `value` with no `onChange`. The same shape repeats
                        for the three hotkey fields below. */}
                    {selectionTranslate !== null && (
                        <InputGroup className='w-[240px]'>
                            <InputGroup.Input
                                type='hotkey'
                                aria-label={t('config.hotkey.set_hotkey')}
                                placeholder={t('config.hotkey.set_hotkey')}
                                value={selectionTranslate}
                                readOnly
                                onKeyDown={(e) => {
                                    keyDown(e, setSelectionTranslate);
                                }}
                                onFocus={() => {
                                    unregister(selectionTranslate);
                                    setSelectionTranslate('');
                                }}
                            />
                            <InputGroup.Suffix>
                                <Button
                                    size='sm'
                                    variant='primary'
                                    className={`${selectionTranslate === '' ? 'hidden' : ''}`}
                                    onPress={() => {
                                        registerHandler('hotkey_selection_translate', selectionTranslate);
                                    }}
                                >
                                    {t('common.ok')}
                                </Button>
                            </InputGroup.Suffix>
                        </InputGroup>
                    )}
                </Row>
                <Row
                    label={t('config.hotkey.selection_replace')}
                    desc={t('config.hotkey.selection_replace_desc')}
                >
                    {selectionReplace !== null && (
                        <InputGroup className='w-[240px]'>
                            <InputGroup.Input
                                type='hotkey'
                                aria-label={t('config.hotkey.set_hotkey')}
                                placeholder={t('config.hotkey.set_hotkey')}
                                value={selectionReplace}
                                readOnly
                                onKeyDown={(e) => {
                                    keyDown(e, setSelectionReplace);
                                }}
                                onFocus={() => {
                                    unregister(selectionReplace);
                                    setSelectionReplace('');
                                }}
                            />
                            <InputGroup.Suffix>
                                <Button
                                    size='sm'
                                    variant='primary'
                                    className={`${selectionReplace === '' ? 'hidden' : ''}`}
                                    onPress={() => {
                                        registerHandler('hotkey_selection_replace', selectionReplace);
                                    }}
                                >
                                    {t('common.ok')}
                                </Button>
                            </InputGroup.Suffix>
                        </InputGroup>
                    )}
                </Row>
                <Row
                    label={t('config.hotkey.input_translate')}
                    desc={t('config.hotkey.input_translate_desc')}
                >
                    {inputTranslate !== null && (
                        <InputGroup className='w-[240px]'>
                            <InputGroup.Input
                                type='hotkey'
                                aria-label={t('config.hotkey.set_hotkey')}
                                placeholder={t('config.hotkey.set_hotkey')}
                                value={inputTranslate}
                                readOnly
                                onKeyDown={(e) => {
                                    keyDown(e, setInputTranslate);
                                }}
                                onFocus={() => {
                                    unregister(inputTranslate);
                                    setInputTranslate('');
                                }}
                            />
                            <InputGroup.Suffix>
                                <Button
                                    size='sm'
                                    variant='primary'
                                    className={`${inputTranslate === '' ? 'hidden' : ''}`}
                                    onPress={() => {
                                        registerHandler('hotkey_input_translate', inputTranslate);
                                    }}
                                >
                                    {t('common.ok')}
                                </Button>
                            </InputGroup.Suffix>
                        </InputGroup>
                    )}
                </Row>
                <Row
                    label={t('config.hotkey.ocr_recognize')}
                    desc={t('config.hotkey.ocr_recognize_desc')}
                >
                    {ocrRecognize !== null && (
                        <InputGroup className='w-[240px]'>
                            <InputGroup.Input
                                type='hotkey'
                                aria-label={t('config.hotkey.set_hotkey')}
                                placeholder={t('config.hotkey.set_hotkey')}
                                value={ocrRecognize}
                                readOnly
                                onKeyDown={(e) => {
                                    keyDown(e, setOcrRecognize);
                                }}
                                onFocus={() => {
                                    unregister(ocrRecognize);
                                    setOcrRecognize('');
                                }}
                            />
                            <InputGroup.Suffix>
                                <Button
                                    size='sm'
                                    variant='primary'
                                    className={`${ocrRecognize === '' ? 'hidden' : ''}`}
                                    onPress={() => {
                                        registerHandler('hotkey_ocr_recognize', ocrRecognize);
                                    }}
                                >
                                    {t('common.ok')}
                                </Button>
                            </InputGroup.Suffix>
                        </InputGroup>
                    )}
                </Row>
                <Row
                    label={t('config.hotkey.ocr_translate')}
                    desc={t('config.hotkey.ocr_translate_desc')}
                >
                    {ocrTranslate !== null && (
                        <InputGroup className='w-[240px]'>
                            <InputGroup.Input
                                type='hotkey'
                                aria-label={t('config.hotkey.set_hotkey')}
                                placeholder={t('config.hotkey.set_hotkey')}
                                value={ocrTranslate}
                                readOnly
                                onKeyDown={(e) => {
                                    keyDown(e, setOcrTranslate);
                                }}
                                onFocus={() => {
                                    unregister(ocrTranslate);
                                    setOcrTranslate('');
                                }}
                            />
                            <InputGroup.Suffix>
                                <Button
                                    size='sm'
                                    variant='primary'
                                    className={`${ocrTranslate === '' ? 'hidden' : ''}`}
                                    onPress={() => {
                                        registerHandler('hotkey_ocr_translate', ocrTranslate);
                                    }}
                                >
                                    {t('common.ok')}
                                </Button>
                            </InputGroup.Suffix>
                        </InputGroup>
                    )}
                </Row>
            </Section>
            <Section
                name={t('config.hotkey.section.processes')}
                note={t('config.hotkey.section.processes_note')}
            >
                <Row
                    label={t('config.hotkey.suppressed_processes')}
                    desc={t('config.hotkey.suppressed_processes_desc')}
                >
                    {suppressedProcesses !== null && (
                        <div className='flex w-[300px] flex-col items-stretch gap-2'>
                            <TextField
                                aria-label={t('config.hotkey.suppressed_processes')}
                                value={processText}
                                onChange={setProcessText}
                            >
                                <TextArea
                                    fullWidth
                                    rows={4}
                                    placeholder={t('config.hotkey.suppressed_processes_placeholder')}
                                />
                            </TextField>
                            <Button
                                size='sm'
                                variant='outline'
                                isDisabled={loadingProcesses || savingProcesses || addingProcesses}
                                onPress={openProcessPicker}
                            >
                                {loadingProcesses
                                    ? t('config.hotkey.process_picker_loading')
                                    : t('config.hotkey.process_picker_open')}
                            </Button>
                            <div className='flex items-center justify-between gap-3'>
                                <span
                                    className={`flat-meta ${hotkeysSuspended ? 'text-accent' : ''}`}
                                    role='status'
                                >
                                    {hotkeysSuspended
                                        ? t('config.hotkey.suppression_active')
                                        : t('config.hotkey.suppression_inactive')}
                                </span>
                                <Button
                                    size='sm'
                                    variant='primary'
                                    isDisabled={savingProcesses || addingProcesses}
                                    onPress={saveSuppressedProcesses}
                                >
                                    {t('common.save')}
                                </Button>
                            </div>
                        </div>
                    )}
                </Row>
            </Section>
            <ProcessPicker
                isOpen={pickerOpen}
                processes={runningProcesses}
                selected={(suppressedProcesses ?? []).map((name) => name.toLocaleLowerCase())}
                loading={loadingProcesses}
                busy={addingProcesses}
                onOpenChange={setPickerOpen}
                onSubmit={addPickedProcesses}
            />
        </>
    );
}
