import { Button, Dropdown } from '@heroui/react';
import { BiCollapseVertical, BiExpandVertical } from 'react-icons/bi';
import { BaseDirectory, readTextFile } from '@tauri-apps/plugin-fs';
import { sendNotification } from '@tauri-apps/plugin-notification';
import React, { useEffect, useState, useRef } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { HiOutlineVolumeUp } from 'react-icons/hi';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { nanoid } from 'nanoid';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';

import * as builtinCollectionServices from '../../../../services/collection';
import { sourceLanguageAtom, targetLanguageAtom, aiPresetAtom } from '../LanguageArea';
import { useConfig, useToastStyle, useVoice, useDisclosure } from '../../../../hooks';
import GlossaryModal from './GlossaryModal';
import { sourceTextAtom, detectLanguageAtom, replaceSelectionAtom } from '../SourceArea';
import { callService, resolveService, withGlossary } from '../../../../utils/translate_dispatch';
import { addToHistory, buildCacheKey, getCachedTranslation, setCachedTranslation } from '../../../../utils/db';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import { DEFAULT_PRESET } from '../../../../utils/ai_presets';
import * as builtinServices from '../../../../services/translate';
import * as builtinTtsServices from '../../../../services/tts';

import { info, error as logError } from '@tauri-apps/plugin-log';
import {
    INSTANCE_NAME_CONFIG_KEY,
    ServiceSourceType,
    getDisplayInstanceName,
    getServiceName,
    getServiceSouceType,
    whetherPluginService,
} from '../../../../utils/service_instance';

const appWindow = getCurrentWebviewWindow();

let translateID = [];

export default function TargetArea(props) {
    const { index, name, translateServiceInstanceList, pluginList, serviceInstanceConfigMap, ...drag } = props;

    const [currentTranslateServiceInstanceKey, setCurrentTranslateServiceInstanceKey] = useState(name);
    function getInstanceName(instanceKey, serviceNameSupplier) {
        const instanceConfig = serviceInstanceConfigMap[instanceKey] ?? {};
        return getDisplayInstanceName(instanceConfig[INSTANCE_NAME_CONFIG_KEY], serviceNameSupplier);
    }

    const [collectionServiceList] = useConfig('collection_service_list', []);
    const [ttsServiceList] = useConfig('tts_service_list', ['lingva_tts']);
    const [translateSecondLanguage] = useConfig('translate_second_language', 'en');
    const [historyDisable] = useConfig('history_disable', false);
    const [cacheEnable] = useConfig('translate_cache_enable', true);
    const [cacheTtlDays] = useConfig('translate_cache_ttl', 7);
    const [isLoading, setIsLoading] = useState(false);
    const [hide, setHide] = useState(true);

    const [result, setResult] = useState('');
    const [error, setError] = useState('');
    /*
        What the mono status on the right of the service row reports. The design
        puts a machine fact there rather than a spinner, so the row says how long
        the service took -- or that the answer never left the machine.
    */
    const [latencyMs, setLatencyMs] = useState(null);
    const [fromCache, setFromCache] = useState(false);

    const sourceText = useAtomValue(sourceTextAtom);
    const sourceLanguage = useAtomValue(sourceLanguageAtom);
    const targetLanguage = useAtomValue(targetLanguageAtom);
    const aiPreset = useAtomValue(aiPresetAtom);
    const [autoCopy] = useConfig('translate_auto_copy', 'disable');
    const [hideWindow] = useConfig('translate_hide_window', false);
    const [clipboardMonitor] = useConfig('clipboard_monitor', false);

    const detectLanguage = useAtomValue(detectLanguageAtom);
    const replaceSelection = useAtomValue(replaceSelectionAtom);
    const { isOpen: isGlossaryOpen, onOpen: onGlossaryOpen, onOpenChange: onGlossaryOpenChange } = useDisclosure();
    const [glossaryTerm, setGlossaryTerm] = useState('');
    const [ttsPluginInfo, setTtsPluginInfo] = useState();
    const { t } = useTranslation();
    const textAreaRef = useRef();
    const toastStyle = useToastStyle();
    const speak = useVoice();

    useEffect(() => {
        if (error) {
            logError(`[${currentTranslateServiceInstanceKey}]happened error: ` + error);
        }
    }, [error]);

    // listen to translation
    useEffect(() => {
        setResult('');
        setError('');
        setLatencyMs(null);
        setFromCache(false);
        if (
            sourceText.trim() !== '' &&
            sourceLanguage &&
            targetLanguage &&
            autoCopy !== null &&
            hideWindow !== null &&
            clipboardMonitor !== null
        ) {
            if (autoCopy === 'source' && !clipboardMonitor) {
                writeText(sourceText).then(() => {
                    if (hideWindow) {
                        sendNotification({ title: t('common.write_clipboard'), body: sourceText });
                    }
                });
            }
            translate();
        }
    }, [
        sourceText,
        sourceLanguage,
        targetLanguage,
        autoCopy,
        hideWindow,
        currentTranslateServiceInstanceKey,
        clipboardMonitor,
        aiPreset,
    ]);

    function invokeOnce(fn) {
        let isInvoke = false;

        return (...args) => {
            if (isInvoke) {
                return;
            } else {
                fn(...args);
                isInvoke = true;
            }
        };
    }

    const translate = async () => {
        let id = nanoid();
        translateID[index] = id;
        const startedAt = Date.now();

        const translateServiceName = getServiceName(currentTranslateServiceInstanceKey);
        const base = resolveService(currentTranslateServiceInstanceKey, {
            pluginList,
            savedConfig: serviceInstanceConfigMap[currentTranslateServiceInstanceKey],
            preset: aiPreset,
        });
        if (!(sourceLanguage in base.languageMap && targetLanguage in base.languageMap)) {
            setError('Language not supported');
            return;
        }

        // Translating into the language the text is already written in is not
        // useful, so fall back to the configured second language. That reasoning
        // only holds for translation: a summary of Chinese text into Chinese is
        // exactly what was asked for, and swapping to the second language there
        // would silently answer in the wrong one.
        const newTargetLanguage =
            aiPreset === DEFAULT_PRESET && sourceLanguage === 'auto' && targetLanguage === detectLanguage
                ? translateSecondLanguage
                : targetLanguage;

        // Scoped by the languages actually in play: with the source set to auto
        // that is the detected language, not the literal 'auto', which no user
        // would think to scope a term to. It has to happen after the target
        // language is settled, which is why it is not folded into `resolveService`.
        const service = await withGlossary(base, {
            from: sourceLanguage === 'auto' ? detectLanguage : sourceLanguage,
            to: newTargetLanguage,
        });
        const applyGlossary = service.applyGlossary;

        const setHideOnce = invokeOnce(setHide);

        // Everything that has to happen once a translation exists, whether it
        // came back from the service or straight out of the cache.
        const finishTranslate = (v) => {
            setResult(typeof v === 'string' ? v.trim() : v);
            setLatencyMs(Date.now() - startedAt);
            setIsLoading(false);
            if (v !== '') {
                setHideOnce(false);
            }
            if (!historyDisable) {
                addToHistory(
                    sourceText.trim(),
                    detectLanguage,
                    newTargetLanguage,
                    translateServiceName,
                    typeof v === 'string' ? v.trim() : v
                ).catch((e) => logError(`write history failed: ${e}`));
            }
            // Replace mode short-circuits the copy modes below. The window was
            // never shown, so there is nothing to display the result in and
            // nothing to leave open: the first service's answer is typed back
            // over the user's selection and the window goes away.
            //
            // Only the first service, exactly like `autoCopy`: every configured
            // service translates, but only one of them can be pasted, and the
            // top one is the one the user ordered first.
            //
            // Dictionary services answer with an object rather than a string,
            // which has no sensible plain-text form to paste, so those fall
            // through to a notification instead of pasting `[object Object]`.
            if (index === 0 && replaceSelection) {
                if (typeof v === 'string' && v.trim() !== '') {
                    invoke('replace_selection', { text: v.trim() })
                        .then((pasted) => {
                            if (!pasted) {
                                // The paste is synthesised input, which the
                                // foreground application can simply not act on.
                                // Losing the translation silently would be the
                                // worst outcome, so it is at least reported.
                                sendNotification({ title: t('common.write_clipboard'), body: v.trim() });
                            }
                        })
                        .catch((e) => logError(`replace selection failed: ${e}`))
                        .finally(() => appWindow.hide());
                } else {
                    appWindow.hide();
                }
            } else if (index === 0 && !clipboardMonitor) {
                switch (autoCopy) {
                    case 'target':
                        writeText(v).then(() => {
                            if (hideWindow) {
                                sendNotification({ title: t('common.write_clipboard'), body: v });
                            }
                        });
                        break;
                    case 'source_target':
                        writeText(sourceText.trim() + '\n\n' + v).then(() => {
                            if (hideWindow) {
                                sendNotification({
                                    title: t('common.write_clipboard'),
                                    body: sourceText.trim() + '\n\n' + v,
                                });
                            }
                        });
                        break;
                    default:
                        break;
                }
            }
        };

        const cacheKey = buildCacheKey({
            instanceKey: currentTranslateServiceInstanceKey,
            config: service.config,
            from: sourceLanguage,
            to: newTargetLanguage,
            detect: detectLanguage,
            text: sourceText.trim(),
            glossary: service.glossary,
        });

        if (cacheEnable) {
            let cached = null;
            try {
                cached = await getCachedTranslation(cacheKey, cacheTtlDays);
            } catch (e) {
                // A broken cache must never stop a translation.
                logError(`read translation cache failed: ${e}`);
            }
            if (cached !== null) {
                if (translateID[index] !== id) return;
                info(`[${currentTranslateServiceInstanceKey}]cache hit`);
                // The elapsed time of a cache read is not the service's latency,
                // so the row reports where the answer came from instead.
                setFromCache(true);
                finishTranslate(cached);
                return;
            }
        }

        setIsLoading(true);
        setHide(true);

        const onResolve = (rawResult) => {
            info(`[${currentTranslateServiceInstanceKey}]resolve:` + rawResult);
            if (translateID[index] !== id) return;
            // Rewritten before it is cached, not after it is read back: the
            // glossary is part of the cache key, so what the key describes is
            // the finished text.
            const v = applyGlossary(rawResult);
            // Only plain text is cached; dictionary services resolve with an
            // object whose shape is service specific.
            if (cacheEnable && typeof v === 'string' && v.trim() !== '') {
                setCachedTranslation(cacheKey, v.trim()).catch((e) => logError(`write translation cache failed: ${e}`));
            }
            finishTranslate(v);
        };

        const onReject = (e) => {
            info(`[${currentTranslateServiceInstanceKey}]reject:` + e);
            if (translateID[index] !== id) return;
            setError(e.toString());
            setIsLoading(false);
            // In replace mode the error has nowhere to be seen: the window was
            // never shown and is about to be hidden for good. A notification is
            // the only way the user learns why nothing was pasted -- otherwise
            // the hotkey looks like it simply did nothing.
            if (index === 0 && replaceSelection) {
                sendNotification({ title: t('config.hotkey.selection_replace'), body: e.toString() });
                appWindow.hide();
            }
        };

        // Streaming services push partial text through this before resolving.
        // Rewritten as it arrives so the terms do not visibly flip once the
        // stream ends; `onResolve` is still what decides the stored text.
        const onPartialResult = (v) => {
            if (translateID[index] !== id) return;
            setResult(applyGlossary(v));
            setHideOnce(false);
        };

        callService(service, sourceText.trim(), sourceLanguage, newTargetLanguage, {
            detect: detectLanguage,
            setResult: onPartialResult,
        }).then(onResolve, onReject);
    };

    // hide empty textarea
    useEffect(() => {
        if (textAreaRef.current !== null) {
            textAreaRef.current.style.height = '0px';
            if (result !== '') {
                textAreaRef.current.style.height = textAreaRef.current.scrollHeight + 'px';
            }
        }
    }, [result]);

    // refresh tts config
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

    // handle tts speak
    const handleSpeak = async () => {
        // See SourceArea's handleSpeak: with no tts service configured `[0]` is
        // undefined and `getServiceSouceType` throws on `undefined.startsWith`.
        if (!ttsServiceList?.length) {
            throw new Error(t('translate.no_tts_service'));
        }
        const instanceKey = ttsServiceList[0];
        if (getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN) {
            const pluginConfig = serviceInstanceConfigMap[instanceKey];
            if (!(targetLanguage in ttsPluginInfo.language)) {
                throw new Error('Language not supported');
            }
            let [func, utils] = await invoke_plugin('tts', getServiceName(instanceKey));
            let data = await func(result, ttsPluginInfo.language[targetLanguage], {
                config: pluginConfig,
                utils,
            });
            speak(data);
        } else {
            if (!(targetLanguage in builtinTtsServices[getServiceName(instanceKey)].Language)) {
                throw new Error('Language not supported');
            }
            const instanceConfig = serviceInstanceConfigMap[instanceKey];
            let data = await builtinTtsServices[getServiceName(instanceKey)].tts(
                result,
                builtinTtsServices[getServiceName(instanceKey)].Language[targetLanguage],
                {
                    config: instanceConfig,
                }
            );
            speak(data);
        }
    };

    // The service icon, whether it comes from a builtin or from an installed
    // `.potext` plugin. Both spellings appear four times below; this is the one
    // place the difference is decided.
    const serviceIcon = (instanceKey) =>
        whetherPluginService(instanceKey)
            ? pluginList['translate'][getServiceName(instanceKey)].icon
            : builtinServices[getServiceName(instanceKey)].info.icon;

    const serviceLabel = (instanceKey) =>
        whetherPluginService(instanceKey)
            ? getInstanceName(instanceKey, () => pluginList['translate'][getServiceName(instanceKey)].display)
            : getInstanceName(instanceKey, () => t(`services.translate.${getServiceName(instanceKey)}.title`));

    /*
        The mono fact on the right of the row, in the order the design reads it:
        what went wrong, what is happening, how long it took, or -- for a service
        that has not been asked anything yet -- that it is folded away.
    */
    const status = () => {
        if (error !== '') return t('translate.status.failed');
        if (isLoading) return t('translate.status.translating');
        if (fromCache) return t('translate.status.cached');
        if (latencyMs !== null) return `${(latencyMs / 1000).toFixed(2)}s`;
        if (hide) return t('translate.status.collapsed');
        return '';
    };

    const hasText = typeof result === 'string' && result !== '';

    return (
        <section className={`translate-section ${hide ? 'translate-section--quiet' : ''}`}>
            {/*
                The row is the drag handle for reordering, so the collapse control
                stays a separate target rather than the whole header being clickable.
            */}
            <div
                className={`translate-service ${hide ? '' : 'bg-surface-secondary'}`}
                {...drag}
            >
                {/* current service instance and available service instance to change */}
                <Dropdown>
                    <Button className='translate-service__name'>
                        <img src={serviceIcon(currentTranslateServiceInstanceKey)} />
                        <span>{serviceLabel(currentTranslateServiceInstanceKey)}</span>
                    </Button>
                    <Dropdown.Popover>
                        <Dropdown.Menu
                            aria-label='translate service'
                            className='max-h-[40vh] overflow-y-auto'
                            onAction={(key) => {
                                setCurrentTranslateServiceInstanceKey(key);
                            }}
                        >
                            {translateServiceInstanceList.map((instanceKey) => {
                                return (
                                    <Dropdown.Item
                                        key={instanceKey}
                                        id={instanceKey}
                                    >
                                        <img
                                            src={serviceIcon(instanceKey)}
                                            className='h-[20px] my-auto'
                                        />
                                        <div className='my-auto'>{serviceLabel(instanceKey)}</div>
                                    </Dropdown.Item>
                                );
                            })}
                        </Dropdown.Menu>
                    </Dropdown.Popover>
                </Dropdown>
                {/*
                    What used to be a Spinner. The design reports progress as a word
                    in the same slot that later reports the latency, so the row never
                    changes shape between asking and answering.
                */}
                <span className={`translate-meta ${error !== '' ? 'translate-meta--error' : ''}`}>{status()}</span>
                {/* content collapse */}
                <button
                    type='button'
                    className='translate-iconbtn'
                    aria-expanded={!hide}
                    onClick={() => setHide(!hide)}
                >
                    {hide ? (
                        <BiExpandVertical className='text-[14px]' />
                    ) : (
                        <BiCollapseVertical className='text-[14px]' />
                    )}
                </button>
            </div>
            {/* The one thing framer-motion was still here for: animating to a height
                nobody has measured. `grid-template-rows: 0fr -> 1fr` does the same
                without it, and unlike `interpolate-size` it is not Chromium-only --
                this app also runs on WKWebView and WebKitGTK. The inner div needs
                `min-h-0`, or it refuses to shrink below its own content. */}
            <div
                className='collapsible'
                data-collapsed={hide}
            >
                <div className='min-h-0 overflow-hidden'>
                    {/* result content */}
                    <div className={`translate-body ${hide ? 'p-0' : 'px-[10px] pt-[8px]'}`}>
                        {typeof result === 'string' ? (
                            <textarea
                                ref={textAreaRef}
                                className='translate-body w-full h-0 resize-none bg-transparent select-text outline-hidden'
                                readOnly
                                value={result}
                            />
                        ) : (
                            <div>
                                {result['pronunciations'] &&
                                    result['pronunciations'].map((pronunciation) => {
                                        return (
                                            <div key={nanoid()}>
                                                {pronunciation['region'] && (
                                                    <span className='mr-[12px] text-muted'>
                                                        {pronunciation['region']}
                                                    </span>
                                                )}
                                                {pronunciation['symbol'] && (
                                                    <span className='mr-[12px] text-muted'>
                                                        {pronunciation['symbol']}
                                                    </span>
                                                )}
                                                {pronunciation['voice'] && pronunciation['voice'] !== '' && (
                                                    <HiOutlineVolumeUp
                                                        className='inline-block my-auto cursor-pointer'
                                                        onClick={() => {
                                                            speak(pronunciation['voice']);
                                                        }}
                                                    />
                                                )}
                                            </div>
                                        );
                                    })}
                                {result['explanations'] &&
                                    result['explanations'].map((explanations) => {
                                        return (
                                            <div key={nanoid()}>
                                                {explanations['explains'] &&
                                                    explanations['explains'].map((explain, index) => {
                                                        return (
                                                            <span key={nanoid()}>
                                                                {index === 0 ? (
                                                                    <>
                                                                        <span className='text-[0.875em] text-muted mr-[12px]'>
                                                                            {explanations['trait']}
                                                                        </span>
                                                                        <span className='font-bold select-text'>
                                                                            {explain}
                                                                        </span>
                                                                        <br />
                                                                    </>
                                                                ) : (
                                                                    <span
                                                                        className='text-[0.875em] text-muted select-text mr-1'
                                                                        key={nanoid()}
                                                                    >
                                                                        {explain}
                                                                    </span>
                                                                )}
                                                            </span>
                                                        );
                                                    })}
                                            </div>
                                        );
                                    })}
                                <br />
                                {result['associations'] &&
                                    result['associations'].map((association) => {
                                        return (
                                            <div key={nanoid()}>
                                                <span className='text-muted'>{association}</span>
                                            </div>
                                        );
                                    })}
                                {result['sentence'] &&
                                    result['sentence'].map((sentence, index) => {
                                        return (
                                            <div key={nanoid()}>
                                                <span className='text-[0.875em] mr-[12px]'>{index + 1}.</span>
                                                <>
                                                    {sentence['source'] && (
                                                        <span
                                                            className='select-text'
                                                            dangerouslySetInnerHTML={{
                                                                __html: sentence['source'],
                                                            }}
                                                        />
                                                    )}
                                                </>
                                                <>
                                                    {sentence['target'] && (
                                                        <div
                                                            className='select-text text-muted'
                                                            dangerouslySetInnerHTML={{
                                                                __html: sentence['target'],
                                                            }}
                                                        />
                                                    )}
                                                </>
                                            </div>
                                        );
                                    })}
                            </div>
                        )}
                        {error !== '' ? (
                            error.split('\n').map((v) => {
                                return (
                                    <p
                                        key={v}
                                        className='text-danger'
                                    >
                                        {v}
                                    </p>
                                );
                            })
                        ) : (
                            <></>
                        )}
                    </div>
                    <div className={`translate-bar ${hide ? 'hidden' : ''}`}>
                        <div className='translate-bar__actions'>
                            {/* copy button */}
                            <button
                                type='button'
                                className='translate-action'
                                disabled={!hasText}
                                onClick={() => {
                                    writeText(result);
                                }}
                            >
                                {t('translate.copy')}
                            </button>
                            {/* speak button */}
                            <button
                                type='button'
                                className='translate-action'
                                disabled={!hasText || !ttsServiceList?.length}
                                title={ttsServiceList?.length ? undefined : t('translate.no_tts_service')}
                                onClick={() => {
                                    handleSpeak().catch((e) => {
                                        toast.error(e.toString(), { style: toastStyle });
                                    });
                                }}
                            >
                                {t('translate.speak')}
                            </button>
                            {/* add to glossary button */}
                            <button
                                type='button'
                                className='translate-action'
                                disabled={!hasText}
                                title={t('translate.add_glossary')}
                                onClick={() => {
                                    // Whatever the user has highlighted, from
                                    // either pane -- highlighting the word that
                                    // came out wrong is how anyone would start.
                                    // Failing that the whole source, but only
                                    // when it is short enough to plausibly be a
                                    // term: a glossary entry for a paragraph
                                    // would never match anything again.
                                    const selected = window.getSelection()?.toString().trim() ?? '';
                                    const source = sourceText.trim();
                                    setGlossaryTerm(selected || (source.length <= 40 ? source : ''));
                                    onGlossaryOpen();
                                }}
                            >
                                {t('translate.add_glossary')}
                            </button>
                            {/* translate back button */}
                            <button
                                type='button'
                                className='translate-action'
                                disabled={!hasText}
                                title={t('translate.translate_back')}
                                onClick={async () => {
                                    setError('');
                                    let newTargetLanguage = sourceLanguage;
                                    if (sourceLanguage === 'auto') {
                                        newTargetLanguage = detectLanguage;
                                    }
                                    let newSourceLanguage = targetLanguage;
                                    if (sourceLanguage === 'auto') {
                                        newSourceLanguage = 'auto';
                                    }
                                    if (whetherPluginService(currentTranslateServiceInstanceKey)) {
                                        const pluginInfo =
                                            pluginList['translate'][getServiceName(currentTranslateServiceInstanceKey)];
                                        if (
                                            newSourceLanguage in pluginInfo.language &&
                                            newTargetLanguage in pluginInfo.language
                                        ) {
                                            setIsLoading(true);
                                            setHide(true);
                                            const instanceConfig =
                                                serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                                            instanceConfig['enable'] = 'true';
                                            const setHideOnce = invokeOnce(setHide);
                                            let [func, utils] = await invoke_plugin(
                                                'translate',
                                                getServiceName(currentTranslateServiceInstanceKey)
                                            );
                                            func(
                                                result.trim(),
                                                pluginInfo.language[newSourceLanguage],
                                                pluginInfo.language[newTargetLanguage],
                                                {
                                                    config: instanceConfig,
                                                    detect: detectLanguage,
                                                    setResult: (v) => {
                                                        setResult(v);
                                                        setHideOnce(false);
                                                    },
                                                    utils,
                                                }
                                            ).then(
                                                (v) => {
                                                    if (v === result) {
                                                        setResult(v + ' ');
                                                    } else {
                                                        setResult(v.trim());
                                                    }
                                                    setIsLoading(false);
                                                    if (v !== '') {
                                                        setHideOnce(false);
                                                    }
                                                },
                                                (e) => {
                                                    setError(e.toString());
                                                    setIsLoading(false);
                                                }
                                            );
                                        } else {
                                            setError('Language not supported');
                                        }
                                    } else {
                                        const LanguageEnum =
                                            builtinServices[getServiceName(currentTranslateServiceInstanceKey)]
                                                .Language;
                                        if (newSourceLanguage in LanguageEnum && newTargetLanguage in LanguageEnum) {
                                            setIsLoading(true);
                                            setHide(true);
                                            const instanceConfig =
                                                serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                                            const setHideOnce = invokeOnce(setHide);
                                            builtinServices[getServiceName(currentTranslateServiceInstanceKey)]
                                                .translate(
                                                    result.trim(),
                                                    LanguageEnum[newSourceLanguage],
                                                    LanguageEnum[newTargetLanguage],
                                                    {
                                                        config: instanceConfig,
                                                        detect: newSourceLanguage,
                                                        setResult: (v) => {
                                                            setResult(v);
                                                            setHideOnce(false);
                                                        },
                                                    }
                                                )
                                                .then(
                                                    (v) => {
                                                        if (v === result) {
                                                            setResult(v + ' ');
                                                        } else {
                                                            setResult(v.trim());
                                                        }
                                                        setIsLoading(false);
                                                        if (v !== '') {
                                                            setHideOnce(false);
                                                        }
                                                    },
                                                    (e) => {
                                                        setError(e.toString());
                                                        setIsLoading(false);
                                                    }
                                                );
                                        } else {
                                            setError('Language not supported');
                                        }
                                    }
                                }}
                            >
                                {t('translate.back')}
                            </button>
                            {/* error retry button */}
                            {error !== '' && (
                                <button
                                    type='button'
                                    className='translate-action'
                                    onClick={() => {
                                        setError('');
                                        setResult('');
                                        translate();
                                    }}
                                >
                                    {t('translate.retry')}
                                </button>
                            )}
                            {/* available collection service instance -- the only
                                actions still identified by an icon, because the icon
                                IS the service's name here. */}
                            {collectionServiceList &&
                                collectionServiceList.map((collectionServiceInstanceName) => {
                                    return (
                                        <button
                                            type='button'
                                            key={collectionServiceInstanceName}
                                            className='translate-action'
                                            title={t('translate.collect')}
                                            aria-label={t('translate.collect')}
                                            onClick={async () => {
                                                if (
                                                    getServiceSouceType(collectionServiceInstanceName) ===
                                                    ServiceSourceType.PLUGIN
                                                ) {
                                                    const pluginConfig =
                                                        serviceInstanceConfigMap[collectionServiceInstanceName];
                                                    let [func, utils] = await invoke_plugin(
                                                        'collection',
                                                        getServiceName(collectionServiceInstanceName)
                                                    );
                                                    func(sourceText.trim(), result.toString(), {
                                                        config: pluginConfig,
                                                        utils,
                                                    }).then(
                                                        (_) => {
                                                            toast.success(t('translate.add_collection_success'), {
                                                                style: toastStyle,
                                                            });
                                                        },
                                                        (e) => {
                                                            toast.error(e.toString(), { style: toastStyle });
                                                        }
                                                    );
                                                } else {
                                                    const instanceConfig =
                                                        serviceInstanceConfigMap[collectionServiceInstanceName];
                                                    builtinCollectionServices[
                                                        getServiceName(collectionServiceInstanceName)
                                                    ]
                                                        .collection(sourceText, result, {
                                                            config: instanceConfig,
                                                        })
                                                        .then(
                                                            (_) => {
                                                                toast.success(t('translate.add_collection_success'), {
                                                                    style: toastStyle,
                                                                });
                                                            },
                                                            (e) => {
                                                                toast.error(e.toString(), { style: toastStyle });
                                                            }
                                                        );
                                                }
                                            }}
                                        >
                                            <img
                                                src={
                                                    getServiceSouceType(collectionServiceInstanceName) ===
                                                    ServiceSourceType.PLUGIN
                                                        ? pluginList['collection'][
                                                              getServiceName(collectionServiceInstanceName)
                                                          ].icon
                                                        : builtinCollectionServices[
                                                              getServiceName(collectionServiceInstanceName)
                                                          ].info.icon
                                                }
                                            />
                                        </button>
                                    );
                                })}
                        </div>
                    </div>
                </div>
            </div>
            <GlossaryModal
                isOpen={isGlossaryOpen}
                onOpenChange={onGlossaryOpenChange}
                defaultTerm={glossaryTerm}
                // The pair actually being translated, so 'auto' never reaches
                // the stored row -- `getActiveGlossary` matches on the detected
                // language, and nobody scopes a term to "auto".
                fromLang={sourceLanguage === 'auto' ? detectLanguage || 'all' : sourceLanguage}
                toLang={targetLanguage || 'all'}
                onSaved={translate}
            />
        </section>
    );
}
