import React, { useState } from 'react';
import { renderScreen, fireEvent, waitFor } from '../../test/render';
import { StemOptAttributeForm } from '../StemOptAttributeForm';
import { suggestTags } from '../../services/apiService';

// The STEM OPT join/attribute form (Phase 6b): the shared card adapted to the
// group form's flat `values`/`onChange(key,value)` contract + a
// paste-your-timeline on-ramp. Scope: stem-opt-extension only.

jest.mock('../../services/apiService', () => ({
  suggestTags: jest.fn(),
}));

// Stateful harness so the controlled card reflects onChange and we can spy on
// exactly which (key, value) pairs the form emits.
function Harness({ onChangeSpy }: { onChangeSpy?: (k: string, v: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  return (
    <StemOptAttributeForm
      values={values}
      onChange={(k, v) => {
        onChangeSpy?.(k, v);
        setValues((prev) => ({ ...prev, [k]: v }));
      }}
      notes={notes}
      onNotesChange={setNotes}
    />
  );
}

describe('StemOptAttributeForm (mobile)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the card, the notes field, and the paste on-ramp', async () => {
    const screen = await renderScreen(<Harness />);
    expect(screen.getByTestId('stem-opt-timeline-card')).toBeOnTheScreen();
    expect(screen.getByTestId('stem-opt-paste')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Anything else worth sharing with the cohort?')).toBeOnTheScreen();
  });

  it('maps a card date edit back to the flat onChange(key, value)', async () => {
    const spy = jest.fn();
    const screen = await renderScreen(<Harness onChangeSpy={spy} />);
    await fireEvent.changeText(screen.getByLabelText('Date applied (I-765 filed)'), '2026-03-18');
    expect(spy).toHaveBeenCalledWith('ead_filed_date', '2026-03-18');
  });

  it('maps a card checkbox toggle back to onChange with the CHECKBOX_ON value', async () => {
    const spy = jest.fn();
    const screen = await renderScreen(<Harness onChangeSpy={spy} />);
    await fireEvent.press(screen.getByLabelText('Premium processing'));
    expect(spy).toHaveBeenCalledWith('premium_processing', 'yes');
  });

  it('paste → tag-suggest → prefills only the canonical fields it returns', async () => {
    (suggestTags as jest.Mock).mockResolvedValue({
      groups: {},
      key_dates: { ead_filed_date: '2026-03-18', ead_approved_date: '2026-09-17' },
      key_stages_or_info: { application_status: 'approved', off_schema_key: 'nope' },
      relevant_sections: [],
      posting_type: '',
    });
    const spy = jest.fn();
    const screen = await renderScreen(<Harness onChangeSpy={spy} />);
    await fireEvent.changeText(screen.getByTestId('stem-opt-paste'), 'Filed 2026-03-18, approved 2026-09-17.');
    await fireEvent.press(screen.getByTestId('stem-opt-extract'));

    await waitFor(() => expect(spy).toHaveBeenCalledWith('ead_filed_date', '2026-03-18'));
    expect(spy).toHaveBeenCalledWith('ead_approved_date', '2026-09-17');
    expect(spy).toHaveBeenCalledWith('application_status', 'approved');
    expect(spy).not.toHaveBeenCalledWith('off_schema_key', expect.anything());
    expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent(/Filled 3 fields/);
  });

  it('says so when a pasted timeline yields no recognizable fields', async () => {
    (suggestTags as jest.Mock).mockResolvedValue({
      groups: {}, key_dates: {}, key_stages_or_info: {}, relevant_sections: [], posting_type: '',
    });
    const screen = await renderScreen(<Harness />);
    await fireEvent.changeText(screen.getByTestId('stem-opt-paste'), 'no dates here');
    await fireEvent.press(screen.getByTestId('stem-opt-extract'));
    await waitFor(() =>
      expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent(/No timeline fields found/),
    );
  });

  it('surfaces an error message when the extract request fails, without mutating fields', async () => {
    (suggestTags as jest.Mock).mockRejectedValue(new Error('network down'));
    const spy = jest.fn();
    const screen = await renderScreen(<Harness onChangeSpy={spy} />);
    await fireEvent.changeText(screen.getByTestId('stem-opt-paste'), 'some timeline');
    await fireEvent.press(screen.getByTestId('stem-opt-extract'));
    await waitFor(() =>
      expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent(/Could not read that timeline/),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports a single filled field and tolerates a missing key_stages bucket', async () => {
    // Response omits key_stages_or_info entirely → exercises the `|| {}` guard.
    (suggestTags as jest.Mock).mockResolvedValue({ key_dates: { ead_filed_date: '2026-03-18' } });
    const screen = await renderScreen(<Harness />);
    await fireEvent.changeText(screen.getByTestId('stem-opt-paste'), 'x');
    await fireEvent.press(screen.getByTestId('stem-opt-extract'));
    await waitFor(() => expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent(/Filled 1 field —/));
  });
});
