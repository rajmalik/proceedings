import React from 'react';
import { renderScreen, fireEvent } from '../../test/render';
import { StemOptTimelineCard } from '../StemOptTimelineCard';
import { STEM_OPT_TIMELINE_FIELDS, stemOptCaptureCount } from '../../lib/stemOptTimeline';

// STEM OPT shared capture card — Phase 4 (mobile parity for the website
// component). Scope: STEM OPT only.

const noop = () => {};

describe('StemOptTimelineCard (mobile)', () => {
  it('renders every canonical field by its label', async () => {
    const screen = await renderScreen(
      <StemOptTimelineCard keyDates={{}} keyStages={{}} onChange={noop} />,
    );
    for (const f of STEM_OPT_TIMELINE_FIELDS) {
      expect(screen.getByLabelText(f.label)).toBeOnTheScreen();
    }
  });

  it('prefills the filing date from the key_dates it is given', async () => {
    const screen = await renderScreen(
      <StemOptTimelineCard
        keyDates={{ ead_filed_date: '2026-03-18', ead_approved_date: '2026-09-17' }}
        keyStages={{ application_status: 'approved' }}
        onChange={noop}
      />,
    );
    expect(screen.getByLabelText('Date applied (I-765 filed)').props.value).toBe('2026-03-18');
  });

  it('flags the missing filing-date anchor and clears it once provided', async () => {
    const blank = await renderScreen(<StemOptTimelineCard keyDates={{}} keyStages={{}} onChange={noop} />);
    expect(blank.getByTestId('needs-ead_filed_date')).toBeOnTheScreen();

    const filled = await renderScreen(
      <StemOptTimelineCard keyDates={{ ead_filed_date: '2026-03-18' }} keyStages={{}} onChange={noop} />,
    );
    expect(filled.queryByTestId('needs-ead_filed_date')).toBeNull();
  });

  it('computes a readable summary with total days', async () => {
    const screen = await renderScreen(
      <StemOptTimelineCard
        keyDates={{ ead_filed_date: '2026-03-01', ead_approved_date: '2026-03-31' }}
        keyStages={{ premium_processing: 'yes' }}
        onChange={noop}
      />,
    );
    const summary = screen.getByTestId('stem-opt-summary');
    expect(summary).toHaveTextContent(/Filed Mar 2026/);
    expect(summary).toHaveTextContent(/approved in 30 days/);
    expect(summary).toHaveTextContent(/30 days total/);
  });

  it('stemOptCaptureCount counts populated canonical fields, ignoring off-schema keys', () => {
    expect(stemOptCaptureCount({}, {})).toEqual({ captured: 0, total: STEM_OPT_TIMELINE_FIELDS.length });
    expect(
      stemOptCaptureCount({ ead_filed_date: '2026-03-18', ead_approved_date: '2026-09-17' }, { application_status: 'approved' }),
    ).toEqual({ captured: 3, total: STEM_OPT_TIMELINE_FIELDS.length });
    expect(stemOptCaptureCount({ ead_filed_date: '2026-03-18', not_a_field: 'x' }, {})).toEqual({
      captured: 1,
      total: STEM_OPT_TIMELINE_FIELDS.length,
    });
  });

  it('shows a partial-parse capture count', async () => {
    const screen = await renderScreen(
      <StemOptTimelineCard keyDates={{ ead_filed_date: '2026-03-18' }} keyStages={{}} onChange={noop} />,
    );
    expect(screen.getByTestId('stem-opt-capture')).toHaveTextContent(
      `1 of ${STEM_OPT_TIMELINE_FIELDS.length} captured`,
    );
  });

  it('edits a date field back through onChange', async () => {
    const onChange = jest.fn();
    const screen = await renderScreen(<StemOptTimelineCard keyDates={{}} keyStages={{}} onChange={onChange} />);
    fireEvent.changeText(screen.getByLabelText('Date applied (I-765 filed)'), '2026-03-18');
    expect(onChange).toHaveBeenLastCalledWith({ ead_filed_date: '2026-03-18' }, {});
  });

  it('toggles a checkbox field back through onChange', async () => {
    const onChange = jest.fn();
    const screen = await renderScreen(<StemOptTimelineCard keyDates={{}} keyStages={{}} onChange={onChange} />);
    fireEvent.press(screen.getByLabelText('Premium processing'));
    expect(onChange).toHaveBeenLastCalledWith({}, { premium_processing: 'yes' });
  });

  it('clearing a prefilled date removes it from the bucket (never keeps a blank)', async () => {
    const onChange = jest.fn();
    const screen = await renderScreen(
      <StemOptTimelineCard keyDates={{ ead_filed_date: '2026-03-18' }} keyStages={{}} onChange={onChange} />,
    );
    fireEvent.changeText(screen.getByLabelText('Date applied (I-765 filed)'), '');
    expect(onChange).toHaveBeenLastCalledWith({}, {});
  });

  it('unchecking a checkbox removes its stage key', async () => {
    const onChange = jest.fn();
    const screen = await renderScreen(
      <StemOptTimelineCard keyDates={{}} keyStages={{ premium_processing: 'yes' }} onChange={onChange} />,
    );
    fireEvent.press(screen.getByLabelText('Premium processing'));
    expect(onChange).toHaveBeenLastCalledWith({}, {});
  });
});
