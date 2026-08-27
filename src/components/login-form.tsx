'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { loginSchema, type LoginInput } from '@/lib/validation/schemas';
import { signIn } from '@/server/actions/auth';

export function LoginForm() {
  const router = useRouter();
  const [serverError, setServerError] = React.useState<string | null>(null);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: LoginInput) {
    setServerError(null);
    const result = await signIn(values);

    if (result.ok) {
      toast.success('Signed in.');
      router.replace('/');
      router.refresh();
      return;
    }

    setServerError(result.error);
    for (const issue of result.issues ?? []) {
      form.setError(issue.field as keyof LoginInput, { message: issue.message });
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
      <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          autoFocus
          aria-invalid={!!form.formState.errors.email}
          {...form.register('email')}
        />
      </Field>

      <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={!!form.formState.errors.password}
          {...form.register('password')}
        />
      </Field>

      {serverError ? <p className="text-destructive text-sm font-medium">{serverError}</p> : null}

      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
