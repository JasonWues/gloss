import { BaseDirectory, readTextFile } from '@tauri-apps/plugin-fs';
import React, { useEffect, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import toast from 'react-hot-toast';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { atom, useAtom, useSetAtom } from 'jotai';
import { getServiceName, getServiceSouceType, ServiceSourceType } from '../../../../utils/service_instance';
import { useConfig, useSyncAtom, useVoice, useToastStyle } from '../../../../hooks';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import * as recognizeServices from '../../../../services/recognize';
import * as builtinTtsServices from '../../../../services/tts';
import detect from '../../../../utils/lang_detect';
import { store } from '../../../../utils/store';
import { info } from '@tauri-apps/plugin-log';
import { debug } from '@tauri-apps/plugin-log';

const appWindow = getCurrentWebviewWindow();

export const sourceTextAtom = atom('');
export const detectLanguageAtom = atom('');
// Whether this translation was started by the replace hotkey, and so should be
// pasted back over the user's selection rather than displayed. Read from Rust
// once per incoming text and published here, because the answer is needed in
// two places: this component decides whether the window appears at all, and
// TargetArea decides what to do with the first result.
export const replaceSelectionAtom = atom(false);

let unlisten = null;

// `keydown` for the key that commits an IME candidate is dispatched before
// `compositionend`, so the ref is still true at that point -- but the browser's
// own flag is the authoritative signal, and this checks it first.
function isComposing(event) {
    return event.nativeEvent?.isComposing || event.keyCode === 229;
}

export default function SourceArea(props) {
    const { pluginList, serviceInstanceConfigMap } = props;
    const [sourceText, setSourceText, syncSourceText] = useSyncAtom(sourceTextAtom);
    const [detectLanguage, setDetectLanguage] = useAtom(detectLanguageAtom);
    const setReplaceSelection = useSetAtom(replaceSelectionAtom);
    const [incrementalTranslate] = useConfig('incremental_translate', false);
    const [dynamicTranslate] = useConfig('dynamic_translate', false);
    const [deleteNewline] = useConfig('translate_delete_newline', false);
    const [recognizeLanguage] = useConfig('recognize_language', 'auto');
    const [recognizeServiceList] = useConfig('recognize_service_list', ['system', 'tesseract']);
    const [ttsServiceList] = useConfig('tts_service_list', ['lingva_tts']);
    const [hideWindow] = useConfig('translate_hide_window', false);
    const [hideSource] = useConfig('hide_source', false);
    const [ttsPluginInfo, setTtsPluginInfo] = useState();
    const [windowType, setWindowType] = useState('[SELECTION_TRANSLATE]');
    const toastStyle = useToastStyle();
    const { t } = useTranslation();
    const textAreaRef = useRef();
    // True between compositionstart and compositionend, i.e. while an IME has a
    // word in progress. A ref rather than state because it is read inside a
    // timeout and must not schedule a render of its own.
    const isComposingRef = useRef(false);
    // The pending dynamic-translate timer. A ref rather than a plain `let` in the
    // component body: typing re-renders, which reinitialised that variable to
    // null, so `clearTimeout` never had anything to clear and every keystroke
    // armed a translation of its own instead of one after the pause.
    const sourceTextChangeTimerRef = useRef(null);
    const speak = useVoice();

    const handleNewText = async (text) => {
        text = text.trim();
        // Asked once per incoming text, before anything else touches the
        // window: in replace mode it must neither appear nor take focus, since
        // the result is delivered by synthesising Ctrl+V into whichever
        // application the user selected the text in.
        const replace = await invoke('get_replace_selection').catch(() => false);
        setReplaceSelection(replace);
        if (hideWindow || replace) {
            appWindow.hide();
        } else {
            appWindow.show();
            appWindow.setFocus();
        }
        // 清空检测语言
        setDetectLanguage('');
        if (text === '[INPUT_TRANSLATE]') {
            setWindowType('[INPUT_TRANSLATE]');
            appWindow.show();
            appWindow.setFocus();
            setSourceText('', true);
        } else if (text === '[IMAGE_TRANSLATE]') {
            setWindowType('[IMAGE_TRANSLATE]');
            const base64 = await invoke('get_base64');
            const serviceInstanceKey = recognizeServiceList[0];
            if (getServiceSouceType(serviceInstanceKey) === ServiceSourceType.PLUGIN) {
                if (recognizeLanguage in pluginList['recognize'][getServiceName(serviceInstanceKey)].language) {
                    const pluginConfig = serviceInstanceConfigMap[serviceInstanceKey];

                    let [func, utils] = await invoke_plugin('recognize', getServiceName(serviceInstanceKey));
                    func(
                        base64,
                        pluginList['recognize'][getServiceName(serviceInstanceKey)].language[recognizeLanguage],
                        {
                            config: pluginConfig,
                            utils,
                        }
                    ).then(
                        (v) => {
                            let newText = v.trim();
                            if (deleteNewline) {
                                newText = v.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                            } else {
                                newText = v.trim();
                            }
                            if (incrementalTranslate) {
                                setSourceText((old) => {
                                    return old + ' ' + newText;
                                });
                            } else {
                                setSourceText(newText);
                            }
                            detect_language(newText).then(() => {
                                syncSourceText();
                            });
                        },
                        (e) => {
                            setSourceText(e.toString());
                        }
                    );
                } else {
                    setSourceText('Language not supported');
                }
            } else {
                if (recognizeLanguage in recognizeServices[getServiceName(serviceInstanceKey)].Language) {
                    const instanceConfig = serviceInstanceConfigMap[serviceInstanceKey];
                    recognizeServices[getServiceName(serviceInstanceKey)]
                        .recognize(
                            base64,
                            recognizeServices[getServiceName(serviceInstanceKey)].Language[recognizeLanguage],
                            {
                                config: instanceConfig,
                            }
                        )
                        .then(
                            (v) => {
                                let newText = v.trim();
                                if (deleteNewline) {
                                    newText = v.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                                } else {
                                    newText = v.trim();
                                }
                                if (incrementalTranslate) {
                                    setSourceText((old) => {
                                        return old + ' ' + newText;
                                    });
                                } else {
                                    setSourceText(newText);
                                }
                                detect_language(newText).then(() => {
                                    syncSourceText();
                                });
                            },
                            (e) => {
                                setSourceText(e.toString());
                            }
                        );
                } else {
                    setSourceText('Language not supported');
                }
            }
        } else {
            setWindowType('[SELECTION_TRANSLATE]');
            let newText = text.trim();
            if (deleteNewline) {
                newText = text.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
            } else {
                newText = text.trim();
            }
            if (incrementalTranslate) {
                setSourceText((old) => {
                    return old + ' ' + newText;
                });
            } else {
                setSourceText(newText);
            }
            detect_language(newText).then(() => {
                syncSourceText();
            });
        }
    };

    const keyDown = (event) => {
        // Enter also picks the highlighted candidate out of an IME's list, and
        // that keystroke arrives here first. Without this, choosing a Chinese
        // candidate translates whatever half-typed text is in the box.
        if (event.key === 'Enter' && !event.shiftKey && !isComposing(event)) {
            event.preventDefault();
            detect_language(sourceText).then(() => {
                syncSourceText();
            });
        }
        if (event.key === 'Escape') {
            appWindow.close();
        }
    };

    const handleSpeak = async () => {
        // `[]` is truthy, so the length check is what keeps `[0]` from being
        // undefined when every tts service has been removed -- `getServiceSouceType`
        // would then throw a bare TypeError on `undefined.startsWith` and the toast
        // would show that instead of the actual problem. The button is disabled in
        // that state; this is the guard behind it.
        if (!ttsServiceList?.length) {
            throw new Error(t('translate.no_tts_service'));
        }
        const instanceKey = ttsServiceList[0];
        let detected = detectLanguage;
        if (detected === '') {
            detected = await detect(sourceText);
            setDetectLanguage(detected);
        }
        if (getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN) {
            if (!(detected in ttsPluginInfo.language)) {
                throw new Error('Language not supported');
            }
            const pluginConfig = serviceInstanceConfigMap[instanceKey];
            let [func, utils] = await invoke_plugin('tts', getServiceName(instanceKey));
            let data = await func(sourceText, ttsPluginInfo.language[detected], {
                config: pluginConfig,
                utils,
            });
            speak(data);
        } else {
            if (!(detected in builtinTtsServices[getServiceName(instanceKey)].Language)) {
                throw new Error('Language not supported');
            }
            const instanceConfig = serviceInstanceConfigMap[instanceKey];
            let data = await builtinTtsServices[getServiceName(instanceKey)].tts(
                sourceText,
                builtinTtsServices[getServiceName(instanceKey)].Language[detected],
                {
                    config: instanceConfig,
                }
            );
            speak(data);
        }
    };

    useEffect(() => {
        if (hideWindow !== null) {
            if (unlisten) {
                unlisten.then((f) => {
                    f();
                });
            }
            unlisten = listen('new_text', (event) => {
                // No `setFocus` here. It was redundant -- `handleNewText` shows
                // and focuses the window itself on the path that wants it -- and
                // it fired before that function could decide, so it focused the
                // window even in the two modes that keep it hidden. For the
                // replace hotkey that is not cosmetic: the foreground
                // application has to stay foreground to be pasted into.
                handleNewText(event.payload);
            });
        }
    }, [hideWindow]);

    useEffect(() => {
        // `[]` is truthy, so the length check is what keeps `[0]` from being undefined
        // when every tts service has been removed.
        if (ttsServiceList?.length && getServiceSouceType(ttsServiceList[0]) === ServiceSourceType.PLUGIN) {
            readTextFile(`plugins/tts/${getServiceName(ttsServiceList[0])}/info.json`, {
                baseDir: BaseDirectory.AppConfig,
            }).then((infoStr) => {
                setTtsPluginInfo(JSON.parse(infoStr));
            });
        }
    }, [ttsServiceList]);

    useEffect(() => {
        if (
            deleteNewline !== null &&
            incrementalTranslate !== null &&
            recognizeLanguage !== null &&
            recognizeServiceList !== null &&
            hideWindow !== null
        ) {
            invoke('get_text').then((v) => {
                handleNewText(v);
            });
        }
    }, [deleteNewline, incrementalTranslate, recognizeLanguage, recognizeServiceList, hideWindow]);

    useEffect(() => {
        textAreaRef.current.style.height = '50px';
        textAreaRef.current.style.height = textAreaRef.current.scrollHeight + 'px';
    }, [sourceText]);

    const detect_language = async (text) => {
        setDetectLanguage(await detect(text));
    };

    const changeSourceText = async (text) => {
        setDetectLanguage('');
        await setSourceText(text);
        // An IME rewrites the textarea on every keystroke while a word is being
        // composed, so with dynamic translate on, typing pinyin fires a
        // translation of the unfinished syllables. `compositionend` runs one
        // straight away, so nothing is lost by waiting.
        if (dynamicTranslate && !isComposingRef.current) {
            if (sourceTextChangeTimerRef.current) {
                clearTimeout(sourceTextChangeTimerRef.current);
            }
            sourceTextChangeTimerRef.current = setTimeout(() => {
                // The timer outlives the keystroke that armed it, so composition
                // may have started in the meantime.
                if (!isComposingRef.current) {
                    detect_language(text).then(() => {
                        syncSourceText();
                    });
                }
            }, 1000);
        }
    };

    const transformVarName = function (str) {
        let str2 = str;

        // snake_case to SNAKE_CASE
        if (/_[a-z]/.test(str2)) {
            str2 = str2
                .split('_')
                .map((it) => it.toLocaleUpperCase())
                .join('_');
        }
        if (str2 !== str) {
            return str2;
        }

        // SNAKE_CASE to kebab-case
        if (/^[A-Z]+(_[A-Z]+)*$/.test(str2)) {
            str2 = str2
                .split('_')
                .map((it) => it.toLocaleLowerCase())
                .join('-');
        }
        if (str2 !== str) {
            return str2;
        }

        // kebab-case to dot.notation
        if (/-/.test(str2)) {
            str2 = str2
                .split('-')
                .map((it) => it.toLocaleLowerCase())
                .join('.');
        }
        if (str2 !== str) {
            return str2;
        }

        // dot.notation to space separated
        if (/\.[a-z]/.test(str2)) {
            str2 = str2.replaceAll(/(\.)([a-z])/g, (_, _2, it) => ' ' + it);
        }
        if (str2 !== str) {
            return str2;
        }

        // space separated to Title Case
        if (/\s[a-z]/.test(str2)) {
            str2 = str2.replaceAll(/\s([a-z])/g, (_, it) => ' ' + it.toLocaleUpperCase());
            str2 = str2.substring(0, 1).toLocaleUpperCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // Title Case to CamelCase
        if (/\s[A-Z]/.test(str2)) {
            str2 = str2.replaceAll(/\s([A-Z])/g, (_, it) => it);
            str2 = str2.substring(0, 1).toLocaleLowerCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // CamelCase to PascalCase
        if (/^[a-z]+[A-Z]+/.test(str2)) {
            str2 = str2.substring(0, 1).toLocaleUpperCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // PascalCase to snake_case
        if (/[^\s][A-Z]/.test(str2)) {
            str2 = str2.replaceAll(/[A-Z]/g, (it, offset) => {
                return (offset == 0 ? '' : '_') + it.toLocaleLowerCase();
            });
        }

        return str2;
    };
    useEffect(() => {
        textAreaRef.current.addEventListener('keydown', async (event) => {
            if (event.altKey && event.shiftKey && event.code === 'KeyU') {
                const originText = textAreaRef.current.value;
                const selectionStart = textAreaRef.current.selectionStart;
                const selectionEnd = textAreaRef.current.selectionEnd;
                const selectionText = originText.substring(selectionStart, selectionEnd);

                const convertedText = transformVarName(selectionText);
                const targetText =
                    originText.substring(0, selectionStart) + convertedText + originText.substring(selectionEnd);

                await changeSourceText(targetText);
                textAreaRef.current.selectionStart = selectionStart;
                textAreaRef.current.selectionEnd = selectionStart + convertedText.length;
            }
        });
    }, [textAreaRef]);

    return (
        <section
            className={`translate-section bg-surface ${hideSource && windowType !== '[INPUT_TRANSLATE]' ? 'hidden' : ''}`}
        >
            <div className='px-[10px] pt-[10px] pb-[8px] max-h-[40vh] overflow-y-auto'>
                {/*
                    No `text-[Npx]` any more. That class was interpolated from
                    `app_font_size`, and Tailwind 4 only emits utilities it can find
                    as literal strings in the source -- so it never existed. App.jsx
                    writes the setting onto <html> as its font-size instead, which
                    makes `1rem` (`.translate-body`) the size the user actually asked
                    for.
                */}
                <textarea
                    autoFocus
                    ref={textAreaRef}
                    className='translate-body w-full bg-transparent resize-none outline-hidden'
                    value={sourceText}
                    onKeyDown={keyDown}
                    onChange={(e) => {
                        const v = e.target.value;
                        changeSourceText(v);
                    }}
                    onCompositionStart={() => {
                        isComposingRef.current = true;
                    }}
                    onCompositionEnd={(e) => {
                        isComposingRef.current = false;
                        // The word is finished, so translate it now rather
                        // than making the user wait out the debounce -- and
                        // drop any timer armed before composition started, so
                        // it cannot land afterwards and detect the language
                        // from the text as it was then.
                        if (sourceTextChangeTimerRef.current) {
                            clearTimeout(sourceTextChangeTimerRef.current);
                            sourceTextChangeTimerRef.current = null;
                        }
                        if (dynamicTranslate) {
                            detect_language(e.target.value).then(() => {
                                syncSourceText();
                            });
                        }
                    }}
                />
            </div>

            {/*
                Words, not icons. The four source actions used to be a segmented
                ButtonGroup of glyphs whose meaning lived in a tooltip; in this
                system the label IS the control, so the tooltips are gone with the
                icons -- there is nothing left for them to explain.
            */}
            <div className='translate-bar'>
                <div className='translate-bar__actions'>
                    <button
                        type='button'
                        className='translate-action'
                        disabled={!ttsServiceList?.length}
                        title={ttsServiceList?.length ? undefined : t('translate.no_tts_service')}
                        onClick={() => {
                            handleSpeak().catch((e) => {
                                toast.error(e.toString(), { style: toastStyle });
                            });
                        }}
                    >
                        {t('translate.speak')}
                    </button>
                    <button
                        type='button'
                        className='translate-action'
                        onClick={() => {
                            writeText(sourceText);
                        }}
                    >
                        {t('translate.copy')}
                    </button>
                    <button
                        type='button'
                        className='translate-action'
                        title={t('translate.delete_newline')}
                        onClick={() => {
                            const newText = sourceText.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                            setSourceText(newText);
                            detect_language(newText).then(() => {
                                syncSourceText();
                            });
                        }}
                    >
                        {t('translate.unwrap')}
                    </button>
                    <button
                        type='button'
                        className='translate-action'
                        disabled={sourceText === ''}
                        onClick={() => {
                            setSourceText('');
                        }}
                    >
                        {t('common.clear')}
                    </button>
                </div>
                {detectLanguage !== '' && (
                    <span className='translate-detected'>{t(`languages.${detectLanguage}`)}</span>
                )}
                <button
                    type='button'
                    className='translate-primary'
                    onClick={() => {
                        detect_language(sourceText).then(() => {
                            syncSourceText();
                        });
                    }}
                >
                    {t('translate.translate')}
                </button>
            </div>
        </section>
    );
}
