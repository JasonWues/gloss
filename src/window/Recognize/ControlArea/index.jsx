import { Dropdown, Button, Label } from '@heroui/react';
import { atom, useAtom, useSetAtom, useAtomValue } from 'jotai';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { HiTranslate } from 'react-icons/hi';
import { GiCycle } from 'react-icons/gi';
import React, { useEffect } from 'react';
import { nanoid } from 'nanoid';
import * as builtinService from '../../../services/recognize';
import { languageList } from '../../../utils/language';
import { useConfig } from '../../../hooks';
import { textAtom } from '../TextArea';
import { pluginListAtom } from '..';
import { osType } from '../../../utils/env';
import {
    ServiceSourceType,
    getServiceSouceType,
    getServiceName,
    INSTANCE_NAME_CONFIG_KEY,
    getDisplayInstanceName,
} from '../../../utils/service_instance';

export const currentServiceInstanceKeyAtom = atom();
export const languageAtom = atom();
export const recognizeFlagAtom = atom();

export default function ControlArea(props) {
    const { serviceInstanceConfigMap, serviceInstanceList } = props;
    const pluginList = useAtomValue(pluginListAtom);
    const [recognizeLanguage] = useConfig('recognize_language', 'auto');
    const setRecognizeFlag = useSetAtom(recognizeFlagAtom);
    const [currentServiceInstanceKey, setCurrentServiceInstanceKey] = useAtom(currentServiceInstanceKeyAtom);
    const [language, setLanguage] = useAtom(languageAtom);
    const text = useAtomValue(textAtom);
    const { t } = useTranslation();

    function getInstanceName(instanceKey, serviceNameSupplier) {
        const instanceConfig = serviceInstanceConfigMap[instanceKey] ?? {};
        return getDisplayInstanceName(instanceConfig[INSTANCE_NAME_CONFIG_KEY], serviceNameSupplier);
    }

    useEffect(() => {
        if (serviceInstanceList) {
            setCurrentServiceInstanceKey(serviceInstanceList[0]);
        }
        if (recognizeLanguage) {
            setLanguage(recognizeLanguage);
        }
    }, [serviceInstanceList, recognizeLanguage]);

    return (
        /*
            Inputs on the left, actions on the right. The panes above now name
            the service and count the characters themselves, so this bar is only
            the four controls -- each a full-height cell with a hairline between,
            so the dividers rule the bar rather than float in it.
        */
        <div className='recognize-bar'>
            <div className='recognize-bar__group recognize-bar__group--inputs'>
                {currentServiceInstanceKey && (
                    <Dropdown>
                        <Button className='recognize-cell'>
                            <img
                                src={
                                    getServiceSouceType(currentServiceInstanceKey) === ServiceSourceType.PLUGIN
                                        ? pluginList[getServiceName(currentServiceInstanceKey)].icon
                                        : builtinService[getServiceName(currentServiceInstanceKey)].info.icon ===
                                            'system'
                                          ? `logo/${osType}.svg`
                                          : builtinService[getServiceName(currentServiceInstanceKey)].info.icon
                                }
                            />
                            <span>
                                {getServiceSouceType(currentServiceInstanceKey) === ServiceSourceType.PLUGIN
                                    ? getInstanceName(
                                          currentServiceInstanceKey,
                                          () => pluginList[getServiceName(currentServiceInstanceKey)].display
                                      )
                                    : getInstanceName(currentServiceInstanceKey, () =>
                                          t(`services.recognize.${getServiceName(currentServiceInstanceKey)}.title`)
                                      )}
                            </span>
                        </Button>
                        <Dropdown.Popover>
                            <Dropdown.Menu
                                aria-label='service name'
                                className='max-h-[70vh] overflow-y-auto'
                                onAction={(key) => {
                                    setCurrentServiceInstanceKey(key);
                                }}
                            >
                                {serviceInstanceList.map((instanceKey) => {
                                    return (
                                        <Dropdown.Item
                                            key={instanceKey}
                                            id={instanceKey}
                                        >
                                            <img
                                                className='h-[16px] w-[16px] my-auto'
                                                src={
                                                    getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN
                                                        ? pluginList[getServiceName(instanceKey)].icon
                                                        : builtinService[getServiceName(instanceKey)].info.icon ===
                                                            'system'
                                                          ? `logo/${osType}.svg`
                                                          : builtinService[getServiceName(instanceKey)].info.icon
                                                }
                                            />
                                            {getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN
                                                ? getInstanceName(
                                                      instanceKey,
                                                      () => pluginList[getServiceName(instanceKey)].display
                                                  )
                                                : getInstanceName(instanceKey, () =>
                                                      t(`services.recognize.${getServiceName(instanceKey)}.title`)
                                                  )}
                                        </Dropdown.Item>
                                    );
                                })}
                            </Dropdown.Menu>
                        </Dropdown.Popover>
                    </Dropdown>
                )}
                {language && (
                    <Dropdown>
                        <Button className='recognize-cell'>
                            <span>{t(`languages.${language}`)}</span>
                        </Button>
                        <Dropdown.Popover>
                            <Dropdown.Menu
                                aria-label='language'
                                className='max-h-[70vh] overflow-y-auto'
                                onAction={(key) => {
                                    setLanguage(key);
                                }}
                            >
                                <Dropdown.Item
                                    key='auto'
                                    id='auto'
                                >
                                    <Label>{t('languages.auto')}</Label>
                                </Dropdown.Item>
                                {languageList.map((name) => {
                                    return (
                                        <Dropdown.Item
                                            key={name}
                                            id={name}
                                        >
                                            {t(`languages.${name}`)}
                                        </Dropdown.Item>
                                    );
                                })}
                            </Dropdown.Menu>
                        </Dropdown.Popover>
                    </Dropdown>
                )}
            </div>
            <div className='recognize-bar__group recognize-bar__group--actions'>
                {/*
                    Sending to the translate window is a hand-off, not the thing
                    this window is for -- so it stays a plain cell and the accent
                    is spent on Recognize, the one action that re-runs the work.
                */}
                <button
                    type='button'
                    className='recognize-cell'
                    disabled={!text}
                    onClick={() => {
                        if (text) {
                            // Straight to the command, where this used to POST to
                            // Gloss's own local server -- an HTTP round-trip out
                            // of the process and back in, to reach a function
                            // sitting in the same binary. It also made an
                            // in-app button depend on a server that exists for
                            // external integrations: it now answers only POSTs
                            // without an Origin, and the http plugin attaches
                            // one, so this had stopped working -- and it would
                            // have broken again for anyone who turned the server
                            // off in Settings.
                            void invoke('translate_text', { text });
                        }
                    }}
                >
                    <HiTranslate />
                    <span>{t('recognize.translate')}</span>
                </button>
                <button
                    type='button'
                    className='flat-primary'
                    onClick={() => {
                        setRecognizeFlag(nanoid());
                    }}
                >
                    <GiCycle />
                    {t('recognize.recognize')}
                </button>
            </div>
        </div>
    );
}
