"use client";

export default function PayPage({ params }: { params: { id: string } }) {
  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Pay Invoice</h1>
      <p className="text-gray-400">Invoice ID: {params.id}</p>
      <p className="text-gray-400">Payment view goes here (Task 21)</p>
    </main>
  );
}
