import { unregister, isRegistered } from '@tauri-apps/plugin-global-shortcut';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Button, Input, InputGroup } from '@heroui/react';
import React from 'react';

import { useConfig } from '../../../../hooks/useConfig';
import { useToastStyle } from '../../../../hooks';
import { osType } from '../../../../utils/env';
import { Section, Row } from '../../components/Section';
import { invoke } from '@tauri-apps/api/core';

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

    const { t } = useTranslation();
    const toastStyle = useToastStyle();

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
        </>
    );
}
