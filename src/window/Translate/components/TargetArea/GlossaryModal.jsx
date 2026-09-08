import { Button, Input, Label, Modal, ModalBody, ModalFooter, ModalHeader, TextField } from '@heroui/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { addGlossaryEntry } from '../../../../utils/db';
import { useToastStyle } from '../../../../hooks';

// Adding a term from the translate window rather than from the Glossary page.
//
// The moment anyone wants a glossary entry is the moment they are looking at a
// word translated wrongly -- and until this existed, acting on that meant
// opening settings, finding the Glossary page, typing both halves from memory,
// coming back and translating again. The entry it writes is the same row the
// settings page writes; this is only a shorter way to reach it.
export default function GlossaryModal({ isOpen, onOpenChange, defaultTerm, fromLang, toLang, onSaved }) {
    const { t } = useTranslation();
    const toastStyle = useToastStyle();
    const [term, setTerm] = useState('');
    const [replacement, setReplacement] = useState('');
    const [saving, setSaving] = useState(false);

    // Reseeded each time it opens, not once: the same component instance serves
    // every term the user adds during a session, and the second one would
    // otherwise arrive holding the first one's text.
    useEffect(() => {
        if (isOpen) {
            setTerm(defaultTerm ?? '');
            setReplacement('');
        }
    }, [isOpen, defaultTerm]);

    const submit = async (close) => {
        if (term.trim() === '' || saving) {
            return;
        }
        setSaving(true);
        try {
            await addGlossaryEntry({
                term: term.trim(),
                replacement: replacement.trim(),
                fromLang,
                toLang,
            });
            close();
            // The caller re-translates. It is not a courtesy: the glossary
            // signature is part of the cache key, so the new term misses the
            // cache and the user sees the change rather than the old answer.
            onSaved?.();
        } catch (e) {
            toast.error(e.toString(), { style: toastStyle });
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
        >
            <Modal.Container>
                <Modal.Dialog>
                    {({ close }) => (
                        <>
                            <ModalHeader>{t('translate.add_glossary')}</ModalHeader>
                            <ModalBody>
                                <TextField
                                    value={term}
                                    onChange={setTerm}
                                    aria-label={t('config.glossary.term')}
                                >
                                    <Label>{t('config.glossary.term')}</Label>
                                    <Input placeholder={t('config.glossary.term')} />
                                </TextField>
                                <TextField
                                    value={replacement}
                                    onChange={setReplacement}
                                    aria-label={t('config.glossary.replacement')}
                                >
                                    <Label>{t('config.glossary.replacement')}</Label>
                                    <Input placeholder={t('config.glossary.replacement')} />
                                </TextField>
                                {/* The scope is shown but not editable. It is
                                    the pair being translated right now, which is
                                    what someone adding a term from here means;
                                    anything else is a job for the Glossary page. */}
                                <div className='flat-meta'>
                                    {t('config.glossary.scope')}: {fromLang} → {toLang}
                                </div>
                            </ModalBody>
                            <ModalFooter>
                                <Button
                                    variant='tertiary'
                                    onPress={close}
                                >
                                    {t('common.cancel')}
                                </Button>
                                <Button
                                    variant='primary'
                                    isDisabled={term.trim() === '' || saving}
                                    onPress={() => submit(close)}
                                >
                                    {t('common.save')}
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </Modal.Dialog>
            </Modal.Container>
        </Modal>
    );
}
