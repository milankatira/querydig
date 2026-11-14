<?php

namespace App\Http\Controllers;

use App\Models\Order;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class OrderController extends Controller
{
    public function index(Request $request)
    {
        // N+1: one query per user (critical: loop over query results)
        $users = User::where('active', true)->get();
        foreach ($users as $user) {
            $user->orders()->where('status', 'paid')->get();
        }

        // whole table loaded into memory, then iterated (autofix: User::lazy())
        foreach (User::all() as $u) {
            $u->touch();
        }

        // COUNT used as an existence check (autofix: ->exists())
        if (Order::where('user_id', $request->user()->id)->count() > 0) {
            return response()->json(['has_orders' => true]);
        }

        // insert inside a loop
        foreach ($request->input('items', []) as $item) {
            DB::table('order_items')->insert(['sku' => $item['sku']]);
        }

        // raw SQL: SELECT * and leading-wildcard LIKE
        $rows = DB::select("SELECT * FROM orders WHERE note LIKE '%gift%'");

        // not flagged: request/cache/config getters and plain arrays
        $q = $request->get('q');
        $n = count($rows);
        return view('orders.index', compact('rows', 'q', 'n'));
    }
}
