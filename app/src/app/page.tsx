export default function LandingPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-2xl text-center">
        <h1 className="text-5xl font-bold mb-4">Veil</h1>
        <p className="text-xl text-gray-400 mb-8">Private invoicing on Solana</p>
        <div className="flex gap-4 justify-center">
          <a href="/create" className="px-6 py-3 bg-indigo-600 rounded-lg hover:bg-indigo-700">
            Create Invoice
          </a>
          <a href="/dashboard" className="px-6 py-3 border border-gray-600 rounded-lg hover:border-gray-400">
            Dashboard
          </a>
        </div>
      </div>
    </main>
  );
}
