import React from 'react';
import { renderScreen, fireEvent, waitFor } from '../../test/render';
import { TagPicker } from '../TagPicker';

const OPTIONS = ['H-1B', 'H-4', 'F-1', 'EB-2'];

describe('TagPicker', () => {
  it('shows no suggestions until text is typed', async () => {
    const screen = await renderScreen(<TagPicker placeholder="Add a visa…" options={OPTIONS} onPick={jest.fn()} />);
    expect(screen.queryByText('H-1B')).toBeNull();
  });

  it('filters options case-insensitively as the user types', async () => {
    const screen = await renderScreen(<TagPicker placeholder="Add a visa…" options={OPTIONS} onPick={jest.fn()} />);
    await fireEvent.changeText(screen.getByPlaceholderText('Add a visa…'), 'h-1');
    await waitFor(() => expect(screen.getByText('H-1B')).toBeOnTheScreen());
    expect(screen.queryByText('F-1')).toBeNull();
    expect(screen.queryByText('EB-2')).toBeNull();
  });

  it('shows no suggestions for a substring with zero matches', async () => {
    const screen = await renderScreen(<TagPicker placeholder="Add a visa…" options={OPTIONS} onPick={jest.fn()} />);
    await fireEvent.changeText(screen.getByPlaceholderText('Add a visa…'), 'zzz');
    expect(screen.queryByText('H-1B')).toBeNull();
  });

  it('tapping a suggestion calls onPick with the matched value and clears the input', async () => {
    const onPick = jest.fn();
    const screen = await renderScreen(<TagPicker placeholder="Add a visa…" options={OPTIONS} onPick={onPick} />);
    const input = screen.getByPlaceholderText('Add a visa…');
    await fireEvent.changeText(input, 'h-1');
    await fireEvent.press(await screen.findByText('H-1B'));

    expect(onPick).toHaveBeenCalledWith('H-1B');
    await waitFor(() => expect(input.props.value).toBe(''));
  });
});
