'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2 } from 'lucide-react';

interface AppointmentRow {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  insurance_type: string | null;
  scheduled_start: string;
  status: string;
  location_or_link: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-muted text-muted-foreground',
  confirmed: 'bg-emerald-500/10 text-emerald-500',
  cancelled: 'bg-destructive/10 text-destructive',
  completed: 'bg-primary/10 text-primary',
  no_show: 'bg-amber-500/10 text-amber-500',
  rescheduled: 'bg-blue-500/10 text-blue-500',
};

export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAppointments = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('appointments')
      .select('id, full_name, phone, email, insurance_type, scheduled_start, status, location_or_link')
      .order('scheduled_start', { ascending: true });
    setAppointments((data as AppointmentRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchAppointments();
  }, [fetchAppointments]);

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Appointments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Insurance appointments booked by the AI assistant, or manually.
        </p>
      </div>

      <div className="mt-6 rounded-lg border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : appointments.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            No appointments yet. Once a lead books through the AI assistant, it&apos;ll show up here.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Insurance type</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {appointments.map((appt) => (
                <TableRow key={appt.id}>
                  <TableCell className="font-medium text-foreground">{appt.full_name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <div>{appt.phone}</div>
                    {appt.email && <div className="text-xs">{appt.email}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{appt.insurance_type ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(appt.scheduled_start).toLocaleString('en-US', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize ${
                        STATUS_STYLES[appt.status] ?? 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {appt.status.replace('_', ' ')}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
