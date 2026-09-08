import { enable, isEnabled, disable } from '@tauri-apps/plugin-autostart';
import { Dropdown, Button, Switch, Input, Label, TextField, InputGroup } from '@heroui/react';
import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { info } from '@tauri-apps/plugin-log';
import { LuSun, LuMoon, LuMonitor } from 'react-icons/lu';
import { invoke } from '@tauri-apps/api/core';
import { useTheme } from 'next-themes';

import { useConfig } from '../../../../hooks/useConfig';
import { LanguageFlag } from '../../../../utils/language';
import Flag from '../../../../components/Flag';
import { ACCENT_PRESETS, DEFAULT_ACCENT } from '../../../../utils/accent';
import { themeOptions } from '../../../../utils/theme';
import { useToastStyle } from '../../../../hooks';
import { osType } from '../../../../utils/env';
import { Section, Row } from '../../components/Section';

// react-icons ships the Lucide set as `lu`, so the icons cost no extra
// dependency. Keyed by the same names as `themeOptions`.
const themeIcon = {
    system: LuMonitor,
    light: LuSun,
    dark: LuMoon,
};

function ThemeIcon({ name }) {
    const Icon = themeIcon[name] ?? LuMonitor;
    return <Icon className='text-[16px]' />;
}

let timer = null;

export default function General() {
    const [autoStart, setAutoStart] = useState(false);
    const [fontList, setFontList] = useState(null);
    const [checkUpdate, setCheckUpdate] = useConfig('check_update', true);
    const [serverEnable, setServerEnable] = useConfig('server_enable', true);
    const [serverPort, setServerPort] = useConfig('server_port', 60828);
    const [appLanguage, setAppLanguage] = useConfig('app_language', 'en');
    const [appTheme, setAppTheme] = useConfig('app_theme', 'system');
    const [appFont, setAppFont] = useConfig('app_font', 'default');
    const [appFallbackFont, setAppFallbackFont] = useConfig('app_fallback_font', 'default');
    const [appFontSize, setAppFontSize] = useConfig('app_font_size', 16);
    const [appAccent, setAppAccent] = useConfig('app_accent', DEFAULT_ACCENT);
    const [transparent, setTransparent] = useConfig('transparent', true);
    const [devMode, setDevMode] = useConfig('dev_mode', false);
    const [trayClickEvent, setTrayClickEvent] = useConfig('tray_click_event', 'config');
    const [proxyMode, setProxyMode] = useConfig('proxy_mode', 'system');
    const [proxyHost, setProxyHost] = useConfig('proxy_host', '');
    const [proxyPort, setProxyPort] = useConfig('proxy_port', '');
    const [proxyUsername, setProxyUsername] = useConfig('proxy_username', '');
    const [proxyPassword, setProxyPassword] = useConfig('proxy_password', '');
    const [noProxy, setNoProxy] = useConfig('no_proxy', 'localhost,127.0.0.1');
    const [systemProxy, setSystemProxy] = useState(null);
    const { t, i18n } = useTranslation();
    const { setTheme } = useTheme();
    const toastStyle = useToastStyle();

    const languageName = {
        zh_cn: '简体中文',
        zh_tw: '繁體中文',
        en: 'English',
        ja: '日本語',
        ko: '한국어',
        fr: 'Français',
        es: 'Español',
        ru: 'Русский',
        de: 'Deutsch',
        it: 'Italiano',
        tr: 'Türkçe',
        pt_pt: 'Português',
        pt_br: 'Português (Brasil)',
        nb_no: 'Norsk Bokmål',
        nn_no: 'Norsk Nynorsk',
        fa: 'فارسی',
        uk: 'Українська',
        ar: 'العربية',
        he: 'עִבְרִית',
    };

    useEffect(() => {
        isEnabled().then((v) => {
            setAutoStart(v);
        });
        invoke('font_list').then((v) => {
            setFontList(v);
        });
    }, []);

    // Only worth reading while the system is the thing being followed; in the other
    // two modes what the OS thinks is not what the requests will do.
    useEffect(() => {
        if (proxyMode !== 'system') {
            setSystemProxy(null);
            return;
        }
        invoke('get_system_proxy').then(setSystemProxy);
    }, [proxyMode]);

    return (
        <>
            <Section
                name={t('config.general.section.startup')}
                note={t('config.general.section.startup_note')}
            >
                <Row
                    label={t('config.general.auto_start')}
                    desc={t('config.general.auto_start_desc')}
                >
                    <Switch
                        className='justify-center items-center'
                        isSelected={autoStart}
                        onChange={(v) => {
                            setAutoStart(v);
                            if (v) {
                                enable().then(() => {
                                    info('Auto start enabled');
                                });
                            } else {
                                disable().then(() => {
                                    info('Auto start disabled');
                                });
                            }
                        }}
                    >
                        <Switch.Content>
                            <Switch.Control>
                                <Switch.Thumb />
                            </Switch.Control>
                        </Switch.Content>
                    </Switch>
                </Row>
                <Row
                    label={t('config.general.check_update')}
                    desc={t('config.general.check_update_desc')}
                >
                    {checkUpdate !== null && (
                        <Switch
                            className='justify-center items-center'
                            isSelected={checkUpdate}
                            onChange={(v) => {
                                setCheckUpdate(v);
                            }}
                        >
                            <Switch.Content>
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch.Content>
                        </Switch>
                    )}
                </Row>
                <Row
                    label={t('config.general.server_enable')}
                    desc={t('config.general.server_enable_desc')}
                >
                    {serverEnable !== null && (
                        <Switch
                            className='justify-center items-center'
                            isSelected={serverEnable}
                            onChange={(v) => {
                                setServerEnable(v);
                                // Same story as the port below: the listener is
                                // bound once at startup, so the switch describes
                                // the next launch rather than this one.
                                toast.success(t('config.general.server_port_change'), {
                                    duration: 3000,
                                    style: toastStyle,
                                });
                            }}
                        >
                            <Switch.Content>
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch.Content>
                        </Switch>
                    )}
                </Row>
                <Row
                    label={t('config.general.server_port')}
                    desc={t('config.general.server_port_desc')}
                >
                    {serverPort !== null && (
                        <TextField
                            className='flex w-full flex-row items-center justify-between max-w-[100px]'
                            value={serverPort}
                            onChange={(v) => {
                                if (parseInt(v) !== serverPort) {
                                    if (timer) {
                                        clearTimeout(timer);
                                    }
                                    timer = setTimeout(() => {
                                        toast.success(t('config.general.server_port_change'), {
                                            duration: 3000,
                                            style: toastStyle,
                                        });
                                    }, 1000);
                                }
                                if (v === '') {
                                    setServerPort(0);
                                } else if (parseInt(v) > 65535) {
                                    setServerPort(65535);
                                } else if (parseInt(v) < 0) {
                                    setServerPort(0);
                                } else {
                                    setServerPort(parseInt(v));
                                }
                            }}
                            aria-label={t('config.general.server_port')}
                        >
                            <Input type='number' />
                        </TextField>
                    )}
                </Row>
            </Section>
            <Section
                name={t('config.general.section.appearance')}
                note={t('config.general.section.appearance_note')}
            >
                <Row
                    label={t('config.general.app_language')}
                    desc={t('config.general.app_language_desc')}
                >
                    {appLanguage !== null && (
                        <Dropdown>
                            <Button variant='outline'>
                                <Flag code={LanguageFlag[appLanguage]} />
                                {languageName[appLanguage]}
                            </Button>
                            <Dropdown.Popover>
                                <Dropdown.Menu
                                    aria-label='app language'
                                    className='max-h-[40vh] overflow-y-auto'
                                    onAction={(key) => {
                                        setAppLanguage(key);
                                        i18n.changeLanguage(key);
                                        invoke('update_tray', { language: key, copyMode: '' });
                                    }}
                                >
                                    <Dropdown.Item
                                        key='zh_cn'
                                        id='zh_cn'
                                    >
                                        <Flag code={LanguageFlag.zh_cn} />
                                        简体中文
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='zh_tw'
                                        id='zh_tw'
                                    >
                                        <Flag code={LanguageFlag.zh_cn} />
                                        繁體中文
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='en'
                                        id='en'
                                    >
                                        <Flag code={LanguageFlag.en} />
                                        English
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='ja'
                                        id='ja'
                                    >
                                        <Flag code={LanguageFlag.ja} />
                                        日本語
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='ko'
                                        id='ko'
                                    >
                                        <Flag code={LanguageFlag.ko} />
                                        한국어
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='fr'
                                        id='fr'
                                    >
                                        <Flag code={LanguageFlag.fr} />
                                        Français
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='de'
                                        id='de'
                                    >
                                        <Flag code={LanguageFlag.de} />
                                        Deutsch
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='es'
                                        id='es'
                                    >
                                        <Flag code={LanguageFlag.es} />
                                        Español
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='ru'
                                        id='ru'
                                    >
                                        <Flag code={LanguageFlag.ru} />
                                        Русский
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='it'
                                        id='it'
                                    >
                                        <Flag code={LanguageFlag.it} />
                                        Italiano
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='tr'
                                        id='tr'
                                    >
                                        <Flag code={LanguageFlag.tr} />
                                        Türkçe
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='pt_pt'
                                        id='pt_pt'
                                    >
                                        <Flag code={LanguageFlag.pt_pt} />
                                        Português
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='pt_br'
                                        id='pt_br'
                                    >
                                        <Flag code={LanguageFlag.pt_br} />
                                        Português (Brasil)
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='nb_no'
                                        id='nb_no'
                                    >
                                        <Flag code={LanguageFlag.nb_no} />
                                        Norsk Bokmål
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='nn_no'
                                        id='nn_no'
                                    >
                                        <Flag code={LanguageFlag.nn_no} />
                                        Norsk Nynorsk
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='fa'
                                        id='fa'
                                    >
                                        <Flag code={LanguageFlag.fa} />
                                        فارسی
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='uk'
                                        id='uk'
                                    >
                                        <Flag code={LanguageFlag.uk} />
                                        Українська
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='ar'
                                        id='ar'
                                    >
                                        <Flag code={LanguageFlag.ar} />
                                        العربية
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='he'
                                        id='he'
                                    >
                                        <Flag code={LanguageFlag.he} />
                                        עִבְרִית
                                    </Dropdown.Item>
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown>
                    )}
                </Row>
                <Row
                    label={t('config.general.app_theme')}
                    desc={t('config.general.app_theme_desc')}
                >
                    {appTheme !== null && (
                        <Dropdown>
                            <Button variant='outline'>
                                <ThemeIcon name={appTheme} />
                                {t(`config.general.theme.${appTheme}`)}
                            </Button>
                            <Dropdown.Popover>
                                <Dropdown.Menu
                                    aria-label='app theme'
                                    onAction={(key) => {
                                        setAppTheme(key);
                                        if (key !== 'system') {
                                            setTheme(key);
                                        } else {
                                            if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                                                setTheme('dark');
                                            } else {
                                                setTheme('light');
                                            }
                                            window
                                                .matchMedia('(prefers-color-scheme: dark)')
                                                .addEventListener('change', (e) => {
                                                    if (e.matches) {
                                                        setTheme('dark');
                                                    } else {
                                                        setTheme('light');
                                                    }
                                                });
                                        }
                                    }}
                                >
                                    {themeOptions.map((name) => (
                                        <Dropdown.Item
                                            key={name}
                                            id={name}
                                        >
                                            <ThemeIcon name={name} />
                                            {t(`config.general.theme.${name}`)}
                                        </Dropdown.Item>
                                    ))}
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown>
                    )}
                </Row>
                <Row
                    label={t('config.general.app_accent')}
                    desc={t('config.general.app_accent_desc')}
                >
                    {appAccent !== null && (
                        <div className='accent-picker'>
                            {/* Hands the five tokens back to the theme. Drawn as
                                a swatch like the rest so the row reads as one set
                                of choices rather than a control plus an escape
                                hatch. */}
                            <button
                                type='button'
                                className={`accent-swatch accent-swatch--default${
                                    appAccent === DEFAULT_ACCENT ? ' accent-swatch--on' : ''
                                }`}
                                title={t('config.general.accent_default')}
                                aria-label={t('config.general.accent_default')}
                                aria-pressed={appAccent === DEFAULT_ACCENT}
                                onClick={() => setAppAccent(DEFAULT_ACCENT)}
                            />
                            {ACCENT_PRESETS.map((colour) => (
                                <button
                                    key={colour}
                                    type='button'
                                    className={`accent-swatch${appAccent === colour ? ' accent-swatch--on' : ''}`}
                                    style={{ background: colour }}
                                    title={colour}
                                    aria-label={colour}
                                    aria-pressed={appAccent === colour}
                                    onClick={() => setAppAccent(colour)}
                                />
                            ))}
                            {/* A native colour input rather than v3's
                                ColorPicker: this is one value with no popover to
                                manage, and the OS picker is the one the user
                                already knows. Styled down to the same square as
                                the swatches beside it. */}
                            <input
                                type='color'
                                className={`accent-swatch accent-swatch--custom${
                                    appAccent !== DEFAULT_ACCENT && !ACCENT_PRESETS.includes(appAccent)
                                        ? ' accent-swatch--on'
                                        : ''
                                }`}
                                value={appAccent === DEFAULT_ACCENT ? '#3578e5' : appAccent}
                                title={t('config.general.accent_custom')}
                                aria-label={t('config.general.accent_custom')}
                                onChange={(e) => setAppAccent(e.target.value)}
                            />
                        </div>
                    )}
                </Row>
                <Row
                    label={t('config.general.app_font')}
                    desc={t('config.general.app_font_desc')}
                >
                    {appFont !== null && fontList !== null && (
                        <Dropdown>
                            <Button
                                variant='outline'
                                style={{
                                    fontFamily: appFont === 'default' ? 'sans-serif' : appFont,
                                }}
                            >
                                {appFont === 'default' ? t('config.general.default_font') : appFont}
                            </Button>
                            <Dropdown.Popover>
                                <Dropdown.Menu
                                    aria-label='app font'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        document.documentElement.style.fontFamily = `"${
                                            key === 'default' ? 'sans-serif' : key
                                        }","${appFallbackFont === 'default' ? 'sans-serif' : appFallbackFont}"`;
                                        setAppFont(key);
                                    }}
                                >
                                    <Dropdown.Item
                                        style={{ fontFamily: 'sans-serif' }}
                                        key='default'
                                        id='default'
                                    >
                                        {t('config.general.default_font')}
                                    </Dropdown.Item>
                                    {fontList.map((x) => {
                                        return (
                                            <Dropdown.Item
                                                style={{ fontFamily: x }}
                                                key={x}
                                                id={x}
                                            >
                                                {x}
                                            </Dropdown.Item>
                                        );
                                    })}
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown>
                    )}
                </Row>
                <Row
                    label={t('config.general.app_fallback_font')}
                    desc={t('config.general.app_fallback_font_desc')}
                >
                    {appFallbackFont !== null && fontList !== null && (
                        <Dropdown>
                            <Button
                                variant='outline'
                                style={{
                                    fontFamily: appFallbackFont === 'default' ? 'sans-serif' : appFallbackFont,
                                }}
                            >
                                {appFallbackFont === 'default' ? t('config.general.default_font') : appFallbackFont}
                            </Button>
                            <Dropdown.Popover>
                                <Dropdown.Menu
                                    aria-label='app font'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        document.documentElement.style.fontFamily = `"${
                                            appFont === 'default' ? 'sans-serif' : appFont
                                        }","${key === 'default' ? 'sans-serif' : key}"`;
                                        setAppFallbackFont(key);
                                    }}
                                >
                                    <Dropdown.Item
                                        style={{ fontFamily: 'sans-serif' }}
                                        key='default'
                                        id='default'
                                    >
                                        {t('config.general.default_font')}
                                    </Dropdown.Item>
                                    {fontList.map((x) => {
                                        return (
                                            <Dropdown.Item
                                                style={{ fontFamily: x }}
                                                key={x}
                                                id={x}
                                            >
                                                {x}
                                            </Dropdown.Item>
                                        );
                                    })}
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown>
                    )}
                </Row>
                <Row
                    label={t('config.general.font_size.title')}
                    desc={t('config.general.font_size_desc')}
                >
                    {appFontSize !== null && (
                        <Dropdown>
                            <Button variant='outline'>{t(`config.general.font_size.${appFontSize}`)}</Button>
                            <Dropdown.Popover>
                                <Dropdown.Menu
                                    aria-label='window position'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        document.documentElement.style.fontSize = `${key}px`;
                                        setAppFontSize(key);
                                    }}
                                >
                                    <Dropdown.Item
                                        key={10}
                                        id={10}
                                    >
                                        <Label>{t(`config.general.font_size.10`)}</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key={12}
                                        id={12}
                                    >
                                        <Label>{t(`config.general.font_size.12`)}</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key={14}
                                        id={14}
                                    >
                                        <Label>{t(`config.general.font_size.14`)}</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key={16}
                                        id={16}
                                    >
                                        <Label>{t(`config.general.font_size.16`)}</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key={18}
                                        id={18}
                                    >
                                        <Label>{t(`config.general.font_size.18`)}</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key={20}
                                        id={20}
                                    >
                                        <Label>{t(`config.general.font_size.20`)}</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key={24}
                                        id={24}
                                    >
                                        <Label>{t(`config.general.font_size.24`)}</Label>
                                    </Dropdown.Item>
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown>
                    )}
                </Row>
                <Row
                    className={osType !== 'Windows_NT' ? 'hidden' : ''}
                    label={t('config.general.tray_click_event')}
                    desc={t('config.general.tray_click_event_desc')}
                >
                    {trayClickEvent !== null && (
                        <Dropdown>
                            <Button variant='outline'>{t(`config.general.event.${trayClickEvent}`)}</Button>
                            <Dropdown.Popover>
                                <Dropdown.Menu
                                    aria-label='tray click event'
                                    onAction={(key) => {
                                        setTrayClickEvent(key);
                                    }}
                                >
                                    <Dropdown.Item
                                        key='config'
                                        id='config'
                                    >
                                        <Label>{t('config.general.event.config')}</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='translate'
                                        id='translate'
                                    >
                                        <Label>{t('config.general.event.translate')}</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='ocr_recognize'
                                        id='ocr_recognize'
                                    >
                                        {t('config.general.event.ocr_recognize')}
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='ocr_translate'
                                        id='ocr_translate'
                                    >
                                        {t('config.general.event.ocr_translate')}
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='disable'
                                        id='disable'
                                    >
                                        <Label>{t('config.general.event.disable')}</Label>
                                    </Dropdown.Item>
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown>
                    )}
                </Row>
                <Row
                    className={osType === 'Darwin' ? 'hidden' : ''}
                    label={t('config.general.transparent')}
                    desc={t('config.general.transparent_desc')}
                >
                    {transparent !== null && (
                        <Switch
                            className='justify-center items-center'
                            isSelected={transparent}
                            onChange={(v) => {
                                setTransparent(v);
                            }}
                        >
                            <Switch.Content>
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch.Content>
                        </Switch>
                    )}
                </Row>
                <Row
                    label={t('config.general.dev_mode')}
                    desc={t('config.general.dev_mode_desc')}
                >
                    {devMode !== null && (
                        <Switch
                            className='justify-center items-center'
                            isSelected={devMode}
                            onChange={(v) => {
                                setDevMode(v);
                            }}
                        >
                            <Switch.Content>
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch.Content>
                        </Switch>
                    )}
                </Row>
            </Section>
            <Section
                name={t('config.general.section.network')}
                note={t('config.general.section.network_note')}
            >
                <Row
                    label={t('config.general.proxy.title')}
                    desc={t('config.general.proxy_desc')}
                >
                    {proxyMode !== null && (
                        <Dropdown>
                            <Button variant='outline'>{t(`config.general.proxy.mode.${proxyMode}`)}</Button>
                            <Dropdown.Popover>
                                <Dropdown.Menu
                                    aria-label='proxy mode'
                                    onAction={async (key) => {
                                        if (key === 'manual' && (proxyHost === '' || proxyPort === '')) {
                                            toast.error(t('config.general.proxy_error'), {
                                                duration: 3000,
                                                style: toastStyle,
                                            });
                                            return;
                                        }
                                        setProxyMode(key);
                                        toast.success(t('config.general.proxy_change'), {
                                            duration: 1000,
                                            style: toastStyle,
                                        });
                                    }}
                                >
                                    <Dropdown.Item
                                        key='system'
                                        id='system'
                                    >
                                        <Label>{t('config.general.proxy.mode.system')}</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='manual'
                                        id='manual'
                                    >
                                        <Label>{t('config.general.proxy.mode.manual')}</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item
                                        key='off'
                                        id='off'
                                    >
                                        <Label>{t('config.general.proxy.mode.off')}</Label>
                                    </Dropdown.Item>
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown>
                    )}
                </Row>
                {proxyMode === 'system' && systemProxy !== null && (
                    <div className='flat-note'>
                        <span>
                            {systemProxy.pac_url
                                ? t('config.general.proxy.detected_pac', { url: systemProxy.pac_url })
                                : systemProxy.http || systemProxy.https
                                  ? t('config.general.proxy.detected', {
                                        value: systemProxy.https ?? systemProxy.http,
                                    })
                                  : t('config.general.proxy.detected_none')}
                        </span>
                    </div>
                )}
                <div className={`flat-row flat-row--fields ${proxyMode === 'manual' ? '' : 'hidden'}`}>
                    {proxyHost !== null && (
                        // The `http://` prefix is an InputGroup.Prefix rather
                        // than a child of the input: v3's Input is a real
                        // <input>, a void element that cannot contain anything.
                        <TextField
                            className='mr-2 w-full'
                            value={proxyHost}
                            onChange={(v) => {
                                setProxyHost(v);
                            }}
                            isRequired
                        >
                            <Label className='text-base my-auto'>{t('config.general.proxy.host')}</Label>
                            <InputGroup>
                                <InputGroup.Prefix>http://</InputGroup.Prefix>
                                <InputGroup.Input type='url' />
                            </InputGroup>
                        </TextField>
                    )}
                    {proxyPort !== null && (
                        <TextField
                            className='flex w-full flex-row items-center justify-between ml-2'
                            value={proxyPort}
                            onChange={(v) => {
                                if (parseInt(v) > 65535) {
                                    setProxyPort(65535);
                                } else if (parseInt(v) < 0) {
                                    setProxyPort('');
                                } else {
                                    setProxyPort(parseInt(v));
                                }
                            }}
                            isRequired
                        >
                            <Label className='text-base my-auto'>{t('config.general.proxy.port')}</Label>
                            <Input type='number' />
                        </TextField>
                    )}
                </div>
                <div className={`flat-row flat-row--fields ${proxyMode === 'manual' ? '' : 'hidden'}`}>
                    {proxyUsername !== null && (
                        <TextField
                            className='flex w-full flex-row items-center justify-between mr-2'
                            value={proxyUsername}
                            onChange={(v) => {
                                setProxyUsername(v);
                            }}
                        >
                            <Label className='text-base my-auto'>{t('config.general.proxy.username')}</Label>
                            <Input type='text' />
                        </TextField>
                    )}
                    {proxyPassword !== null && (
                        <TextField
                            className='flex w-full flex-row items-center justify-between ml-2'
                            value={proxyPassword}
                            onChange={(v) => {
                                setProxyPassword(v);
                            }}
                        >
                            <Label className='text-base my-auto'>{t('config.general.proxy.password')}</Label>
                            <Input type='password' />
                        </TextField>
                    )}
                </div>
                <div className={`flat-row flat-row--fields ${proxyMode === 'manual' ? '' : 'hidden'}`}>
                    {noProxy !== null && (
                        <TextField
                            className='flex w-full flex-row items-center justify-between'
                            value={noProxy}
                            onChange={(v) => {
                                setNoProxy(v);
                            }}
                        >
                            <Label className='text-base my-auto'>{t('config.general.proxy.no_proxy')}</Label>
                            <Input />
                        </TextField>
                    )}
                </div>
            </Section>
        </>
    );
}
