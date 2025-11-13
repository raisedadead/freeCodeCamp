import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import CommandPalette from 'react-cmdk';
import { useHits, useSearchBox } from 'react-instantsearch';
import { searchPageUrl } from '../../utils/algolia-locale-setup';
import WithInstantSearch from '../search/with-instant-search';
import type { Hit } from '../search/searchBar/types';
import 'react-cmdk/dist/cmdk.css';
import './command-menu.css';

interface CommandMenuContentProps {
  isOpen: boolean;
  onClose: () => void;
}

function CommandMenuContent({ isOpen, onClose }: CommandMenuContentProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState<'root'>('root');
  const [search, setSearch] = useState('');
  const { refine } = useSearchBox();
  const { results } = useHits<Hit>();

  // Update Algolia search query when command menu search changes
  useEffect(() => {
    if (isOpen) {
      refine(search);
    }
  }, [search, isOpen, refine]);

  const handleClose = useCallback(() => {
    setSearch('');
    setPage('root');
    onClose();
  }, [onClose]);

  const handleNavigate = useCallback(
    (url: string) => {
      window.location.assign(url);
      handleClose();
    },
    [handleClose]
  );

  // Transform Algolia hits into command palette structure
  const searchResultItems =
    results?.hits?.map((hit: Hit) => ({
      id: hit.objectID,
      children: hit.title || 'Untitled',
      icon: '📄',
      onClick: () => handleNavigate(hit.url),
      closeOnSelect: true
    })) || [];

  // Add "See all results" footer item if there are results
  if (search && searchResultItems.length > 0) {
    searchResultItems.push({
      id: 'see-all-results',
      children: t('search.see-results', { defaultValue: 'See all results' }),
      icon: '🔍',
      onClick: () =>
        handleNavigate(`${searchPageUrl}?query=${encodeURIComponent(search)}`),
      closeOnSelect: true
    });
  }

  // Structure items according to react-cmdk format
  const items =
    search && searchResultItems.length > 0
      ? [
          {
            id: 'search-results',
            heading: t('search.results', { defaultValue: 'Search Results' }),
            items: searchResultItems
          }
        ]
      : [];

  // Use items directly since they're already filtered by Algolia
  const filteredItems = items;

  return (
    <CommandPalette
      onChangeSearch={setSearch}
      onChangeOpen={(open: boolean) => {
        if (!open) handleClose();
      }}
      isOpen={isOpen}
      search={search}
      page={page}
      placeholder={t('search.placeholder', {
        defaultValue: 'Search articles...'
      })}
    >
      <CommandPalette.Page id='root'>
        {search ? (
          <>
            {filteredItems.length > 0 ? (
              filteredItems.map((list, listIndex) => (
                <CommandPalette.List key={list.id} heading={list.heading}>
                  {list.items.map((item, itemIndex) => (
                    <CommandPalette.ListItem
                      key={item.id}
                      index={itemIndex}
                      onClick={item.onClick}
                      closeOnSelect={item.closeOnSelect}
                    >
                      {item.icon} {item.children}
                    </CommandPalette.ListItem>
                  ))}
                </CommandPalette.List>
              ))
            ) : (
              <div className='cmdk-empty'>
                {t('search.no-tutorials', {
                  defaultValue: 'No results found'
                })}
              </div>
            )}
          </>
        ) : (
          <div className='cmdk-empty'>
            {t('search.placeholder', {
              defaultValue: 'Type to search articles...'
            })}
          </div>
        )}
      </CommandPalette.Page>
    </CommandPalette>
  );
}

interface CommandMenuProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CommandMenu({ isOpen, onClose }: CommandMenuProps) {
  return (
    <WithInstantSearch>
      <CommandMenuContent isOpen={isOpen} onClose={onClose} />
    </WithInstantSearch>
  );
}
