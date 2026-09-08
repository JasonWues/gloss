import {
    Modal,
    ModalHeader,
    ModalBody,
    ModalFooter,
    Dropdown,
    TextArea,
    Button,
    ButtonGroup,
    Input,
    Pagination,
    Label,
    SearchField,
} from '@heroui/react';
import { readDir, BaseDirectory, readTextFile, exists } from '@tauri-apps/plugin-fs';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/core';
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { save } from '@tauri-apps/plugin-dialog';
import { MdDeleteOutline } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';

import * as builtinCollectionServices from '../../../../services/collection';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import * as builtinServices from '../../../../services/translate';
import { useConfig, useToastStyle, useDisclosure } from '../../../../hooks';
import { LanguageFlag } from '../../../../utils/language';
import Flag from '../../../../components/Flag';
import { getDatabase } from '../../../../utils/db';
import { toCsv } from '../../../../utils/csv';
import { store } from '../../../../utils/store';
import { osType } from '../../../../utils/env';
import {
    ServiceSourceType,
    ServiceType,
    getServiceName,
    getServiceSouceType,
    whetherAvailableService,
} from '../../../../utils/service_instance';

const PAGE_SIZE = 20;
const ALL = '__all__';

const ELLIPSIS = Symbol('ellipsis');

// The page numbers to actually draw. v3's Pagination has no notion of collapsing
// a long run, so this is what v2's `isCompact` did on its own: first and last
// always, a window either side of the current page, and an ellipsis for each gap.
function pageWindow(current, totalPages) {
    if (!Number.isFinite(totalPages) || totalPages < 1) {
        return [1];
    }
    if (totalPages <= 7) {
        return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages = new Set([1, totalPages, current, current - 1, current + 1]);
    const shown = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
    const out = [];
    let previous = 0;
    for (const p of shown) {
        if (p - previous > 1) {
            out.push(ELLIPSIS);
        }
        out.push(p);
        previous = p;
    }
    return out;
}

const CSV_COLUMNS = ['id', 'text', 'source', 'target', 'service', 'result', 'timestamp'];

// Epoch milliseconds is what the column holds and what the JSON export keeps;
// ISO 8601 is what a spreadsheet and a reader both understand, so the CSV gets
// that instead.
const toCsvRow = (row) => ({ ...row, timestamp: new Date(row.timestamp).toISOString() });

export default function History() {
    const [collectionServiceList] = useConfig('collection_service_list', []);
    const { isOpen, onOpen, onOpenChange } = useDisclosure();
    const { isOpen: isClearOpen, onOpen: onClearOpen, onOpenChange: onClearOpenChange } = useDisclosure();
    const [pluginList, setPluginList] = useState(null);
    const [selectedItem, setSelectItem] = useState(null);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [items, setItems] = useState([]);
    const [search, setSearch] = useState('');
    const [serviceFilter, setServiceFilter] = useState(ALL);
    const [targetFilter, setTargetFilter] = useState(ALL);
    const [serviceOptions, setServiceOptions] = useState([]);
    const [targetOptions, setTargetOptions] = useState([]);
    const toastStyle = useToastStyle();
    const { t } = useTranslation();

    useEffect(() => {
        loadPluginList();
        // What the table contains, not what the user is looking at. It changes
        // only when rows are added or removed, so it is loaded once here and
        // again from `deleteItem`/`clearData` -- it used to sit in the effect
        // below, where the two `SELECT DISTINCT` scans it makes ran again on
        // every keystroke and every page change, for an answer that could not
        // have moved.
        loadFilterOptions();
    }, []);

    // Filter changes restart paging; without this a narrowed result set can
    // leave the view on a page that no longer exists.
    useEffect(() => {
        setPage(1);
    }, [search, serviceFilter, targetFilter]);

    useEffect(() => {
        // Debounced because this also runs on every keystroke in the search box.
        const timer = setTimeout(getData, 250);
        return () => clearTimeout(timer);
    }, [search, serviceFilter, targetFilter, page]);

    // Builds the shared WHERE clause. sqlite takes positional `$n` parameters,
    // so the index has to track the params array as it grows.
    const buildFilter = () => {
        const clauses = [];
        const params = [];
        const keyword = search.trim();
        if (keyword !== '') {
            params.push(`%${keyword}%`, `%${keyword}%`);
            clauses.push(`(text LIKE $${params.length - 1} OR result LIKE $${params.length})`);
        }
        if (serviceFilter !== ALL) {
            params.push(serviceFilter);
            clauses.push(`service = $${params.length}`);
        }
        if (targetFilter !== ALL) {
            params.push(targetFilter);
            clauses.push(`target = $${params.length}`);
        }
        return { where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
    };

    const getData = async () => {
        try {
            const db = await getDatabase();
            const { where, params } = buildFilter();
            const countRows = await db.select(`SELECT COUNT(*) AS count FROM history${where}`, params);
            setTotal(countRows[0]?.count ?? 0);
            const rows = await db.select(
                `SELECT * FROM history${where} ORDER BY timestamp DESC, id DESC LIMIT $${params.length + 1} OFFSET $${
                    params.length + 2
                }`,
                [...params, PAGE_SIZE, PAGE_SIZE * (page - 1)]
            );
            setItems(rows);
        } catch (e) {
            toast.error(e.toString(), { style: toastStyle });
        }
    };

    // Only offer filters that actually match something in the table.
    const loadFilterOptions = async () => {
        try {
            const db = await getDatabase();
            const services = await db.select('SELECT DISTINCT service FROM history ORDER BY service');
            setServiceOptions(services.map((row) => row.service));
            const targets = await db.select('SELECT DISTINCT target FROM history ORDER BY target');
            setTargetOptions(targets.map((row) => row.target));
        } catch {
            setServiceOptions([]);
            setTargetOptions([]);
        }
    };

    const getSelectedData = async (id) => {
        const db = await getDatabase();
        let result = await db.select('SELECT * FROM history WHERE id=$1', [id]);
        setSelectItem(result[0]);
    };

    const clearData = async () => {
        const db = await getDatabase();
        // DELETE rather than DROP: the table has to survive so the next
        // translation does not have to recreate it.
        await db.execute('DELETE FROM history');
        await db.execute('VACUUM');
        setItems([]);
        setTotal(0);
        setPage(1);
        setServiceOptions([]);
        setTargetOptions([]);
    };

    const deleteItem = async (id) => {
        const db = await getDatabase();
        await db.execute('DELETE FROM history WHERE id=$1', [id]);
        await getData();
        await loadFilterOptions();
    };

    const updateData = async () => {
        const db = await getDatabase();
        await db.execute('UPDATE history SET text=$1, result=$2 WHERE id=$3', [
            selectedItem.text,
            selectedItem.result,
            selectedItem.id,
        ]);
        await getData();
    };

    // Exports everything the current filters match, not just the visible page.
    const exportData = async (format) => {
        try {
            const selected = await save({
                defaultPath: `gloss-history.${format}`,
                filters: [{ name: format.toUpperCase(), extensions: [format] }],
            });
            if (selected === null) {
                return;
            }
            const db = await getDatabase();
            const { where, params } = buildFilter();
            const rows = await db.select(`SELECT * FROM history${where} ORDER BY timestamp DESC, id DESC`, params);
            const content = format === 'csv' ? toCsv(CSV_COLUMNS, rows.map(toCsvRow)) : JSON.stringify(rows, null, 2);
            await invoke('write_user_file', { path: selected, content });
            toast.success(t('config.history.export_success'), { style: toastStyle });
        } catch (e) {
            toast.error(e.toString(), { style: toastStyle });
        }
    };

    const formatDate = (date) => {
        function padTo2Digits(num) {
            return num.toString().padStart(2, '0');
        }
        const year = date.getFullYear().toString().slice(2, 4);
        const month = padTo2Digits(date.getMonth() + 1);
        const day = padTo2Digits(date.getDate());
        const hour = padTo2Digits(date.getHours());
        const minute = padTo2Digits(date.getMinutes());
        const second = padTo2Digits(date.getSeconds());
        return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
    };

    // The entry states its own time; the heading above it carries the date, so
    // neither has to repeat the other.
    const formatTime = (date) => formatDate(date).slice(9);
    const formatDay = (date) => formatDate(date).slice(0, 8);

    /*
      One pass over the page's rows, splitting on the day they fall in. The rows
      already arrive newest-first from SQL, so insertion order is the order the
      groups should render in and no sort is needed.
    */
    const groupByDay = (rows) => {
        const groups = [];
        for (const item of rows) {
            const day = formatDay(new Date(item.timestamp));
            const last = groups[groups.length - 1];
            if (last && last.day === day) {
                last.rows.push(item);
            } else {
                groups.push({ day, rows: [item] });
            }
        }
        return groups;
    };

    const serviceIcon = (service) =>
        getServiceSouceType(service) === ServiceSourceType.PLUGIN
            ? pluginList['translate'][getServiceName(service)].icon
            : builtinServices[getServiceName(service)].info.icon;

    const serviceLabel = (service) => {
        const name = getServiceName(service);
        if (getServiceSouceType(service) === ServiceSourceType.PLUGIN) {
            return pluginList?.['translate']?.[name]?.display ?? name;
        }
        return t(`services.translate.${name}.title`, { defaultValue: name });
    };

    const loadPluginList = async () => {
        const serviceTypeList = ['translate', 'collection'];
        let temp = {};
        for (const serviceType of serviceTypeList) {
            temp[serviceType] = {};
            if (await exists(`plugins/${serviceType}`, { baseDir: BaseDirectory.AppConfig })) {
                const plugins = await readDir(`plugins/${serviceType}`, { baseDir: BaseDirectory.AppConfig });
                for (const plugin of plugins) {
                    const infoStr = await readTextFile(`plugins/${serviceType}/${plugin.name}/info.json`, {
                        baseDir: BaseDirectory.AppConfig,
                    });
                    let pluginInfo = JSON.parse(infoStr);
                    if ('icon' in pluginInfo) {
                        const appConfigDirPath = await appConfigDir();
                        const iconPath = await join(
                            appConfigDirPath,
                            `/plugins/${serviceType}/${plugin.name}/${pluginInfo.icon}`
                        );
                        pluginInfo.icon = convertFileSrc(iconPath);
                    }
                    temp[serviceType][plugin.name] = pluginInfo;
                }
            }
        }
        setPluginList({ ...temp });
    };

    return (
        pluginList !== null && (
            <div className={`flex flex-col ${osType === 'Linux' ? 'h-[calc(100vh-58px)]' : 'h-[calc(100vh-56px)]'}`}>
                <div className='history-bar'>
                    {/* SearchField, not Input: v3 dropped `isClearable`/`onClear`,
                        and this is the component that carries a clear button of its
                        own. Clearing goes through `onChange` like any other edit, so
                        the separate `onClear` handler is no longer needed. */}
                    <SearchField
                        className='max-w-[40%]'
                        value={search}
                        onChange={setSearch}
                        aria-label={t('config.history.search')}
                    >
                        <SearchField.Group>
                            <SearchField.SearchIcon />
                            <SearchField.Input placeholder={t('config.history.search')} />
                            <SearchField.ClearButton />
                        </SearchField.Group>
                    </SearchField>
                    <Dropdown>
                        <Button
                            size='sm'
                            variant='outline'
                            className='my-auto'
                        >
                            {serviceFilter === ALL ? t('config.history.all_services') : serviceLabel(serviceFilter)}
                        </Button>
                        <Dropdown.Popover>
                            <Dropdown.Menu
                                aria-label='service filter'
                                className='max-h-[50vh] overflow-y-auto'
                                onAction={(key) => setServiceFilter(key)}
                            >
                                <Dropdown.Item
                                    key={ALL}
                                    id={ALL}
                                >
                                    <Label>{t('config.history.all_services')}</Label>
                                </Dropdown.Item>
                                {serviceOptions.map((service) => (
                                    <Dropdown.Item
                                        key={service}
                                        id={service}
                                    >
                                        <Label>{serviceLabel(service)}</Label>
                                    </Dropdown.Item>
                                ))}
                            </Dropdown.Menu>
                        </Dropdown.Popover>
                    </Dropdown>
                    <Dropdown>
                        <Button
                            size='sm'
                            variant='outline'
                            className='my-auto'
                        >
                            {targetFilter === ALL
                                ? t('config.history.all_languages')
                                : t(`languages.${targetFilter}`, { defaultValue: targetFilter })}
                        </Button>
                        <Dropdown.Popover>
                            <Dropdown.Menu
                                aria-label='language filter'
                                className='max-h-[50vh] overflow-y-auto'
                                onAction={(key) => setTargetFilter(key)}
                            >
                                <Dropdown.Item
                                    key={ALL}
                                    id={ALL}
                                >
                                    <Label>{t('config.history.all_languages')}</Label>
                                </Dropdown.Item>
                                {targetOptions.map((language) => (
                                    <Dropdown.Item
                                        key={language}
                                        id={language}
                                    >
                                        {t(`languages.${language}`, { defaultValue: language })}
                                    </Dropdown.Item>
                                ))}
                            </Dropdown.Menu>
                        </Dropdown.Popover>
                    </Dropdown>
                    <span className='history-bar__count'>
                        {t('config.history.showing', { shown: items.length, total })}
                    </span>
                </div>
                {/*
                    The day-grouped list that replaced v3's Table. A table forced
                    every entry onto one line and split it across six cells; here an
                    entry is one block that names its service, pair and time across
                    the top and gives source and result equal width underneath, so
                    long text stays readable instead of being ellipsed at the cell
                    edge. Row click still opens the same editing modal.
                */}
                <div className='history-list'>
                    {items.length === 0 && <div className='history-empty'>{t('config.history.empty')}</div>}
                    {groupByDay(items).map((group) => (
                        <div key={group.day}>
                            <div className='history-day'>
                                <span className='history-day__label'>{group.day}</span>
                                <span className='history-day__count'>
                                    {t('config.history.entry_count', { count: group.rows.length })}
                                </span>
                            </div>
                            {group.rows.map(
                                (item) =>
                                    whetherAvailableService(item.service, {
                                        [ServiceSourceType.BUILDIN]: builtinServices,
                                        [ServiceSourceType.PLUGIN]: pluginList[ServiceType.TRANSLATE],
                                    }) && (
                                        <button
                                            type='button'
                                            key={item.id}
                                            className='history-entry'
                                            onClick={() => {
                                                getSelectedData(item.id);
                                                onOpen();
                                            }}
                                        >
                                            <div className='history-entry__head'>
                                                <img
                                                    src={serviceIcon(item.service)}
                                                    className='history-entry__logo'
                                                    alt=''
                                                    draggable={false}
                                                />
                                                <span className='history-entry__service'>
                                                    {serviceLabel(item.service)}
                                                </span>
                                                <span className='history-entry__pair'>
                                                    {/* The `fi fi-xx` classes this used to carry render
                                                        nothing: flag-icons' stylesheet is deliberately not
                                                        imported (see components/Flag), so only the component
                                                        actually paints a flag. */}
                                                    <Flag code={LanguageFlag[item.source]} />
                                                    <span>→</span>
                                                    <Flag code={LanguageFlag[item.target]} />
                                                </span>
                                                <span className='history-entry__stamp'>
                                                    {formatTime(new Date(item.timestamp))}
                                                </span>
                                            </div>
                                            <div className='history-entry__body'>
                                                <div className='history-entry__text'>{item.text}</div>
                                                <div className='history-entry__result'>{item.result}</div>
                                            </div>
                                        </button>
                                    )
                            )}
                        </div>
                    ))}
                </div>
                <div className='flat-foot'>
                    {/* v3's Pagination renders no pages of its own: `total`, `page`
                        and `onChange` are gone and every link is written out. With
                        none, it produced an empty <nav> with `total` and `page`
                        leaked onto it as DOM attributes.

                        `pageWindow` is what v2's `isCompact` did for free -- keep
                        the run short and stand in an ellipsis -- since a history
                        of any size would otherwise print every page number. */}
                    <Pagination>
                        <Pagination.Content>
                            <Pagination.Item>
                                <Pagination.Previous
                                    isDisabled={page <= 1}
                                    onPress={() => setPage(page - 1)}
                                >
                                    <Pagination.PreviousIcon />
                                </Pagination.Previous>
                            </Pagination.Item>
                            {pageWindow(page, Math.ceil(total / PAGE_SIZE)).map((entry, index) => (
                                <Pagination.Item key={entry === ELLIPSIS ? `gap-${index}` : entry}>
                                    {entry === ELLIPSIS ? (
                                        <Pagination.Ellipsis />
                                    ) : (
                                        <Pagination.Link
                                            isActive={entry === page}
                                            onPress={() => setPage(entry)}
                                        >
                                            {entry}
                                        </Pagination.Link>
                                    )}
                                </Pagination.Item>
                            ))}
                            <Pagination.Item>
                                <Pagination.Next
                                    isDisabled={page >= Math.ceil(total / PAGE_SIZE)}
                                    onPress={() => setPage(page + 1)}
                                >
                                    <Pagination.NextIcon />
                                </Pagination.Next>
                            </Pagination.Item>
                        </Pagination.Content>
                    </Pagination>
                    <ButtonGroup className='my-auto'>
                        <Button
                            size='sm'
                            onPress={() => exportData('csv')}
                        >
                            {t('config.history.export_csv')}
                        </Button>
                        <Button
                            size='sm'
                            onPress={() => exportData('json')}
                        >
                            {t('config.history.export_json')}
                        </Button>
                    </ButtonGroup>
                    {/*
                        `danger-soft` and a confirm step, because this sits one
                        button away from the two exports and used to look
                        exactly like them -- a misclick dropped every row with
                        nothing to undo it.
                    */}
                    <Button
                        size='sm'
                        variant='danger-soft'
                        className='my-auto'
                        onPress={onClearOpen}
                    >
                        {t('common.clear')}
                    </Button>
                </div>

                <Modal>
                    <Modal.Backdrop
                        isOpen={isClearOpen}
                        onOpenChange={onClearOpenChange}
                    >
                        <Modal.Container>
                            <Modal.Dialog>
                                {({ close }) => (
                                    <>
                                        <ModalHeader>{t('common.clear')}</ModalHeader>
                                        <ModalBody>{t('config.history.clear_confirm', { count: total })}</ModalBody>
                                        <ModalFooter>
                                            <Button
                                                variant='tertiary'
                                                onPress={close}
                                            >
                                                {t('common.cancel')}
                                            </Button>
                                            <Button
                                                variant='danger'
                                                onPress={async () => {
                                                    await clearData();
                                                    close();
                                                }}
                                            >
                                                {t('common.ok')}
                                            </Button>
                                        </ModalFooter>
                                    </>
                                )}
                            </Modal.Dialog>
                        </Modal.Container>
                    </Modal.Backdrop>
                    <Modal.Backdrop
                        isOpen={isOpen}
                        onOpenChange={onOpenChange}
                    >
                        <Modal.Container scroll='inside'>
                            <Modal.Dialog className='max-h-[80vh]'>
                                {({ close }) =>
                                    selectedItem && (
                                        <>
                                            <ModalHeader>
                                                <div className='flex justify-start'>
                                                    {getServiceSouceType(selectedItem.service) ===
                                                    ServiceSourceType.PLUGIN ? (
                                                        <img
                                                            src={
                                                                pluginList['translate'][
                                                                    getServiceName(selectedItem.service)
                                                                ].icon
                                                            }
                                                            className='h-[24px] w-[24px] my-auto'
                                                            draggable={false}
                                                        />
                                                    ) : (
                                                        <img
                                                            src={`${builtinServices[getServiceName(selectedItem.service)].info.icon}`}
                                                            className='h-[24px] w-[24px] m-auto mr-[8px]'
                                                            draggable={false}
                                                        />
                                                    )}
                                                </div>
                                            </ModalHeader>
                                            <ModalBody>
                                                <TextArea
                                                    value={selectedItem.text}
                                                    onChange={(e) => {
                                                        setSelectItem({ ...selectedItem, text: e.target.value });
                                                    }}
                                                />
                                                <TextArea
                                                    value={selectedItem.result}
                                                    onChange={(e) => {
                                                        setSelectItem({ ...selectedItem, result: e.target.value });
                                                    }}
                                                />
                                            </ModalBody>
                                            <ModalFooter className='flex justify-between'>
                                                <ButtonGroup>
                                                    <Button
                                                        variant='primary'
                                                        onPress={async () => {
                                                            await updateData();
                                                            close();
                                                        }}
                                                    >
                                                        {t('common.save')}
                                                    </Button>
                                                    {/* Sends the text as it stands in the box above, not
                                                        as it was recorded: the row is editable, and
                                                        fixing a bad OCR read before running it again is
                                                        the obvious reason to want this. Goes through the
                                                        same entry point as the clipboard monitor, so the
                                                        translate window picks the service and language
                                                        pair itself rather than replaying this row's. */}
                                                    <Button
                                                        variant='outline'
                                                        isDisabled={!selectedItem.text?.trim()}
                                                        onPress={() => {
                                                            invoke('translate_text', {
                                                                text: selectedItem.text.trim(),
                                                            });
                                                            close();
                                                        }}
                                                    >
                                                        {t('config.history.retranslate')}
                                                    </Button>
                                                    <Button
                                                        isIconOnly
                                                        variant='danger-soft'
                                                        aria-label={t('config.history.delete')}
                                                        onPress={async () => {
                                                            await deleteItem(selectedItem.id);
                                                            close();
                                                        }}
                                                    >
                                                        <MdDeleteOutline />
                                                    </Button>
                                                </ButtonGroup>
                                                <ButtonGroup>
                                                    {collectionServiceList &&
                                                        collectionServiceList.map((instanceKey) => {
                                                            return (
                                                                <Button
                                                                    key={instanceKey}
                                                                    isIconOnly
                                                                    variant='tertiary'
                                                                    onPress={async () => {
                                                                        if (
                                                                            getServiceSouceType(instanceKey) ===
                                                                            ServiceSourceType.PLUGIN
                                                                        ) {
                                                                            const pluginConfig =
                                                                                (await store.get(instanceKey)) ?? {};
                                                                            let [func, utils] = await invoke_plugin(
                                                                                'collection',
                                                                                getServiceName(instanceKey)
                                                                            );
                                                                            func(
                                                                                selectedItem.text,
                                                                                selectedItem.result,
                                                                                {
                                                                                    config: pluginConfig,
                                                                                    utils,
                                                                                }
                                                                            ).then(
                                                                                (_) => {
                                                                                    toast.success(
                                                                                        t(
                                                                                            'translate.add_collection_success'
                                                                                        ),
                                                                                        {
                                                                                            style: toastStyle,
                                                                                        }
                                                                                    );
                                                                                },
                                                                                (e) => {
                                                                                    toast.error(e.toString(), {
                                                                                        style: toastStyle,
                                                                                    });
                                                                                }
                                                                            );
                                                                        } else {
                                                                            const instanceConfig =
                                                                                (await store.get(instanceKey)) ?? {};
                                                                            builtinCollectionServices[
                                                                                getServiceName(instanceKey)
                                                                            ]
                                                                                .collection(
                                                                                    selectedItem.text,
                                                                                    selectedItem.result,
                                                                                    {
                                                                                        config: instanceConfig,
                                                                                    }
                                                                                )
                                                                                .then(
                                                                                    (_) => {
                                                                                        toast.success(
                                                                                            t(
                                                                                                'translate.add_collection_success'
                                                                                            ),
                                                                                            {
                                                                                                style: toastStyle,
                                                                                            }
                                                                                        );
                                                                                    },
                                                                                    (e) => {
                                                                                        toast.error(e.toString(), {
                                                                                            style: toastStyle,
                                                                                        });
                                                                                    }
                                                                                );
                                                                        }
                                                                    }}
                                                                >
                                                                    <img
                                                                        src={
                                                                            getServiceSouceType(instanceKey) ===
                                                                            ServiceSourceType.PLUGIN
                                                                                ? pluginList['collection'][
                                                                                      getServiceName(instanceKey)
                                                                                  ].icon
                                                                                : builtinCollectionServices[
                                                                                      getServiceName(instanceKey)
                                                                                  ].info.icon
                                                                        }
                                                                        className='h-[24px] w-[24px]'
                                                                    />
                                                                </Button>
                                                            );
                                                        })}
                                                </ButtonGroup>
                                            </ModalFooter>
                                        </>
                                    )
                                }
                            </Modal.Dialog>
                        </Modal.Container>
                    </Modal.Backdrop>
                </Modal>
            </div>
        )
    );
}
