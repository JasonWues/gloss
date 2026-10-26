import {
    Button,
    Checkbox,
    CheckboxGroup,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    SearchField,
} from '@heroui/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

export default function ProcessPicker({ isOpen, processes, selected, loading = false, busy, onOpenChange, onSubmit }) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [checked, setChecked] = useState([]);

    useEffect(() => {
        if (isOpen) {
            setQuery('');
            setChecked([]);
        }
    }, [isOpen]);

    const filtered = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        return processes.filter((process) => process.name.toLocaleLowerCase().includes(needle));
    }, [processes, query]);

    return (
        <Modal>
            <Modal.Backdrop
                isOpen={isOpen}
                onOpenChange={onOpenChange}
            >
                <Modal.Container scroll='inside'>
                    <Modal.Dialog className='max-h-[80vh]'>
                        {({ close }) => (
                            <>
                                <ModalHeader>{t('config.hotkey.process_picker_title')}</ModalHeader>
                                <ModalBody>
                                    <SearchField
                                        aria-label={t('config.hotkey.process_picker_search')}
                                        value={query}
                                        onChange={setQuery}
                                    >
                                        <SearchField.Group>
                                            <SearchField.SearchIcon />
                                            <SearchField.Input placeholder={t('config.hotkey.process_picker_search')} />
                                            <SearchField.ClearButton />
                                        </SearchField.Group>
                                    </SearchField>
                                    {loading || filtered.length === 0 ? (
                                        <p className='py-8 text-center text-sm text-muted'>
                                            {loading
                                                ? t('config.hotkey.process_picker_loading')
                                                : t('config.hotkey.process_picker_empty')}
                                        </p>
                                    ) : (
                                        <CheckboxGroup
                                            aria-label={t('config.hotkey.process_picker_title')}
                                            value={checked}
                                            onChange={setChecked}
                                        >
                                            <div className='flex flex-col'>
                                                {filtered.map((process) => {
                                                    const alreadyAdded = selected.includes(process.name);
                                                    return (
                                                        <Checkbox
                                                            key={process.name}
                                                            value={process.name}
                                                            isDisabled={alreadyAdded || busy}
                                                        >
                                                            <Checkbox.Content>
                                                                <Checkbox.Control>
                                                                    <Checkbox.Indicator />
                                                                </Checkbox.Control>
                                                                <span className='flex-1 font-mono text-sm break-all'>
                                                                    {process.name}
                                                                </span>
                                                                <span className='flat-meta'>
                                                                    {alreadyAdded
                                                                        ? t('config.hotkey.process_picker_added')
                                                                        : process.pids.length > 1
                                                                          ? t(
                                                                                'config.hotkey.process_picker_instances',
                                                                                {
                                                                                    count: process.pids.length,
                                                                                }
                                                                            )
                                                                          : `PID ${process.pids[0]}`}
                                                                </span>
                                                            </Checkbox.Content>
                                                        </Checkbox>
                                                    );
                                                })}
                                            </div>
                                        </CheckboxGroup>
                                    )}
                                </ModalBody>
                                <ModalFooter className='flex items-center justify-between'>
                                    <span className='flat-meta'>
                                        {t('config.hotkey.process_picker_count', { count: filtered.length })}
                                    </span>
                                    <div className='flex gap-2'>
                                        <Button
                                            variant='tertiary'
                                            onPress={close}
                                        >
                                            {t('common.cancel')}
                                        </Button>
                                        <Button
                                            variant='primary'
                                            isDisabled={checked.length === 0 || busy}
                                            onPress={() => onSubmit(checked, close)}
                                        >
                                            {t('config.hotkey.process_picker_add')}
                                        </Button>
                                    </div>
                                </ModalFooter>
                            </>
                        )}
                    </Modal.Dialog>
                </Modal.Container>
            </Modal.Backdrop>
        </Modal>
    );
}
